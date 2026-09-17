// Internal subcommands — the daemon spawns this same binary for bundling and
// RPC execution so every call gets a FRESH module resolver. Bun caches
// (negative) module resolutions per process, so a long-lived daemon would
// never see packages installed after it started — the agent installs deps
// mid-session all the time.
//
// Protocol: JSON request on stdin, JSON response as the LAST stdout line
// (user server code may console.log; the runner rebinds console to stderr,
// but direct process.stdout writes still end up before the final line).

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Minimal .env parsing shared by the RPC runner and the daemon's secrets
// status: KEY=value lines, # comments, first '=' splits, and one pair of
// matching surrounding quotes is stripped (dotenv/Bun convention — a pasted
// KEY="sk-…" must not keep literal quotes in the value).
export function parseEnvContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

async function readStdinJson(): Promise<any> {
  const text = await new Response(Bun.stdin.stream()).text();
  return JSON.parse(text);
}

// Awaits the OS-level flush: process.exit() right after a fire-and-forget
// stdout.write drops everything past the first pipe-buffer chunk (~64KB),
// which any React UI bundle exceeds.
async function reply(obj: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    process.stdout.write('\n' + JSON.stringify(obj) + '\n', (err) => (err ? reject(err) : resolve())),
  );
}

// Resolve every shared (bare) import from ONE place — the workspace root, this
// subprocess's cwd (the daemon sets cwd to the workspace). A dependency an app
// also carries in apps/<id>/node_modules (e.g. a peer pulled in by something it
// `bun add`ed) would otherwise be bundled twice: the app's code binds the local
// copy while a workspace package binds the hoisted copy. For a stateful
// singleton like React that means two instances → a null dispatcher → "Invalid
// hook call" at render; for context-based libs (redux, react-query, emotion …)
// it silently breaks too. Resolving bare specifiers from the root collapses any
// such pair to one instance. Packages that live only in the app (a root resolve
// throws) fall through to Bun's default resolution; relative/absolute/`node:`
// imports are left untouched. Trade-off this encodes: an app cannot shadow the
// workspace's version of a shared dep — the workspace root owns runtime versions.
// Force every react-family specifier (react, react-dom, react-dom/client,
// react/jsx-runtime, …) — including react-dom's own internal `import "react"` —
// to resolve from ONE tree, the workspace root (this subprocess's cwd, set by
// the daemon to the workspace). Without this, an app that carries its own react
// in apps/<id>/node_modules (e.g. pulled in as a lucide-react peer) binds its
// hooks to that copy while react-dom resolves the workspace copy → two React
// instances → a null dispatcher → "Invalid hook call" at render.
//
// Scoped to the react family on purpose. A blanket "resolve every bare import
// from root" also dedupes other libs but is unsafe: Bun.resolveSync picks
// different export conditions than Bun.build's browser-target resolver, so
// redirecting an arbitrary package swaps its entry (CJS/dev) and inflates the
// bundle (~+800KB observed). React's entry is stable, so redirecting it is
// safe. Add other singleton-stateful libs (redux, react-query, emotion, …) here
// if an app ever ships a duplicated copy; the durable cure is install-layer
// dedup so native resolution finds a single physical copy.
function dedupeReactPlugin(): import('bun').BunPlugin {
  const root = process.cwd();
  return {
    name: 'airglow-dedupe-react',
    setup(build) {
      build.onResolve({ filter: /^react($|-dom$|\/|-dom\/)/ }, (args) => {
        try {
          return { path: Bun.resolveSync(args.path, root) };
        } catch {
          return undefined; // let Bun resolve normally if the workspace lacks it
        }
      });
    },
  };
}

// Resolve the workspace `@shared/*` alias in the bundler itself instead of
// leaning on the root tsconfig's `paths`. tsconfig.json is SEED_IF_ABSENT, so
// a stale user copy survives upgrades forever — and Bun (unlike tsc) ignores
// `paths` entirely when `baseUrl` is missing, which broke every @shared import
// on workspaces carrying a pre-relaunch tsconfig. The Tailwind build already
// resolves the alias itself for the same reason (apps.ts runTailwind).
function sharedAliasPlugin(): import('bun').BunPlugin {
  const root = process.cwd();
  return {
    name: 'airglow-shared-alias',
    setup(build) {
      build.onResolve({ filter: /^@shared\// }, (args) => {
        try {
          return { path: Bun.resolveSync('./' + args.path.slice(1), root) };
        } catch {
          return undefined; // shared file genuinely missing — let Bun report it
        }
      });
    },
  };
}

// { entrypoint, format } → { ok, code } | { ok: false, stderr }
export async function runInternalBuild(): Promise<void> {
  try {
    const req = await readStdinJson();
    const result = await Bun.build({
      entrypoints: [String(req.entrypoint)],
      target: 'browser',
      format: req.format === 'esm' ? 'esm' : 'iife',
      loader: { '.svg': 'text', '.txt': 'text', '.md': 'text' },
      plugins: [dedupeReactPlugin(), sharedAliasPlugin()],
      throw: false,
    });
    if (!result.success) {
      await reply({ ok: false, stderr: result.logs.map((l) => String(l)).join("\n") });
      process.exit(0);
    }
    await reply({ ok: true, code: await result.outputs[0].text() });
    process.exit(0);
  } catch (e: any) {
    await reply({ ok: false, stderr: String(e?.message ?? e) });
    process.exit(0);
  }
}

// Server-side SDK: server functions get the subset of the client SDK that
// makes sense off-browser — airglow.connectors (execute/status/disconnect;
// connect is a UI flow and stays client-only), airglow.llm (loops back into
// the daemon, which attaches the user identity itself so the auth token
// never enters this subprocess), and airglow.log (level-tagged lines into
// the daemon log via stderr). Browser-bound APIs (storage, fetch, captureTab,
// platform, rpc) stay client-only on purpose: state crosses the boundary as
// rpc arguments. Installed only when the daemon provided its origin.
function installServerSdk(): void {
  const origin = process.env.AIRGLOW_DAEMON_ORIGIN;
  const appId = process.env.AIRGLOW_APP_ID;
  if (!origin || !appId) return;
  // Opaque nonce tying these loopbacks to the browser that invoked the RPC. The
  // daemon maps it back to that user's identity (no token here on purpose).
  const connectorSession = process.env.AIRGLOW_CONNECTOR_SESSION;
  const call = async (path: string, payload: Record<string, unknown>, errorLabel: string): Promise<any> => {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Airglow-App-Id': appId,
        ...(connectorSession ? { 'X-Airglow-Connector-Session': connectorSession } : {}),
      },
      body: JSON.stringify(payload),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      // error may be a string (daemon envelope) or an object (Anthropic body)
      const message = typeof data?.error === 'string' ? data.error : data?.error?.message;
      const e = new Error(message || `${errorLabel} failed (HTTP ${res.status})`) as any;
      const code = data?.code ?? data?.error?.code ?? data?.error?.type;
      if (code) e.code = code;
      throw e;
    }
    return data;
  };
  const connectorsCall = (action: string, payload: Record<string, unknown>) =>
    call(`/api/connectors/${action}`, { appId, ...payload }, `connectors ${action}`);
  // Same shape as the client SDK's airglow.log; lands in the daemon log
  // (stderr is mirrored there with app/function attribution by handleRpc).
  const logAt = (level: 'info' | 'warn' | 'error') => async (message: unknown, data?: unknown) => {
    let suffix = '';
    if (data !== undefined) {
      try { suffix = ' ' + JSON.stringify(data); } catch { suffix = ' ' + String(data); }
    }
    console[level === 'info' ? 'log' : level](`[${level}] ${typeof message === 'string' ? message : String(message)}${suffix}`);
  };
  (globalThis as any).airglow = {
    connectors: {
      execute: (tool: string, args?: Record<string, unknown>, opts?: { account?: string }) =>
        connectorsCall('execute', { tool, arguments: args ?? {}, account: opts?.account }),
      status: (toolkit: string, opts?: { account?: string }) =>
        connectorsCall('status', { toolkit, account: opts?.account }),
      disconnect: (toolkit: string, opts?: { account?: string }) =>
        connectorsCall('disconnect', { toolkit, account: opts?.account }),
    },
    llm: {
      chat: (payload: Record<string, unknown>) =>
        call('/api/llm/v1/chat/completions', payload, 'llm'),
    },
    jobs: {
      schedule: (jobId: string, opts: { at: number | string | Date; config?: unknown }) => {
        const at = opts?.at instanceof Date ? opts.at.getTime() : opts?.at;
        return call('/api/jobs/schedule', { appId, jobId, at, config: opts?.config }, 'jobs schedule')
          .then((d: any) => d.task);
      },
      cancel: (taskId: string) =>
        call('/api/jobs/cancel', { appId, taskId }, 'jobs cancel').then(() => undefined),
      list: () =>
        call('/api/jobs/tasks', { appId }, 'jobs list').then((d: any) => d.tasks ?? []),
    },
    log: { info: logAt('info'), warn: logAt('warn'), error: logAt('error') },
  };
}

// { entryPath, functionName, body, envFiles[] } → { ok, result } | { ok: false, error }
export async function runInternalRpc(): Promise<void> {
  // User server code may console.log freely — keep the stdout JSON protocol
  // intact by sending console output to stderr (mirrored into the daemon log).
  const realConsole = { ...console };
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[m] = (...args: any[]) => realConsole.error(...args);
  }
  installServerSdk();
  try {
    const req = await readStdinJson();
    for (const envPath of req.envFiles ?? []) {
      try {
        for (const [key, value] of Object.entries(parseEnvContent(readFileSync(envPath, 'utf8')))) {
          if (!(key in process.env)) process.env[key] = value;
        }
      } catch {}
    }
    const mod = await importServerEntry(String(req.entryPath));
    const handler = mod.default ?? mod[String(req.functionName)];
    if (typeof handler !== 'function') {
      await reply({ ok: false, error: `'${req.functionName}' has no default or named export` });
      process.exit(0);
    }
    const result = await handler(req.body);
    await reply({ ok: true, result });
    process.exit(0);
  } catch (e: any) {
    await reply({ ok: false, error: String(e?.message ?? e) });
    process.exit(0);
  }
}

// Imports a server-function entry. In a compiled binary, dynamic import of
// an on-disk file works but bare package specifiers inside it don't resolve
// against the app's node_modules — every server function using an npm
// dependency dies with "Cannot find package". Worse, that failed import
// poisons this process's negative-resolution cache, which then makes even
// Bun.build (whose resolver is otherwise fully functional in compiled mode —
// userscript/UI bundling relies on it) report the same package as
// unresolvable. So in compiled mode we never plain-import first: bundle the
// entry into a self-contained file and import that. The bundle is written
// next to the entry so import.meta.dir/url inside the function still point
// at the app's server directory; the name is dot-prefixed and non-source-ext
// so the daemon's app watcher ignores it. If no bundle attempt succeeds,
// fall through to the plain import for a canonical error message.
async function importServerEntry(entryPath: string): Promise<any> {
  const isCompiled = Bun.main.includes('$bunfs');
  if (isCompiled) {
    const origCwd = process.cwd();
    let code: string | null = null;
    try {
      // Retry with cwd at each ancestor carrying a node_modules (apps/<id>,
      // then the workspace root where the hoisted install lives) — the
      // compiled resolver anchors on cwd rather than the entry's path.
      for (let dir = dirname(entryPath); ; dir = dirname(dir)) {
        if (existsSync(join(dir, 'node_modules'))) {
          process.chdir(dir);
          // target 'node', not 'bun': node keeps node:* builtins external
          // without consulting the embedded standalone graph. bun:* stays
          // external so a function using e.g. bun:sqlite resolves it at
          // import time.
          const bundled = await Bun.build({
            entrypoints: [entryPath],
            target: 'node',
            format: 'esm',
            external: ['bun:*'],
            // Server code may import @shared/* like any other app code; the
            // plugin resolves it against cwd, which this loop has just set —
            // it lands on the workspace root iteration, where shared/ lives.
            plugins: [sharedAliasPlugin()],
            throw: false,
          });
          if (bundled.success) { code = await bundled.outputs[0].text(); break; }
        }
        if (dir === dirname(dir)) break;
      }
    } finally {
      process.chdir(origCwd);
    }
    if (code !== null) {
      // A timeout-killed predecessor never reaches its finally — sweep
      // orphaned bundles before writing this one. Only clearly stale ones:
      // a concurrent RPC's live bundle (written moments ago, mid-import)
      // must survive the sweep.
      const entryDir = dirname(entryPath);
      try {
        for (const f of readdirSync(entryDir)) {
          if (!f.startsWith('.rpc-bundle-') || !f.endsWith('.mjs')) continue;
          try {
            if (Date.now() - statSync(join(entryDir, f)).mtimeMs > 300_000) {
              unlinkSync(join(entryDir, f));
            }
          } catch {}
        }
      } catch {}
      const tmpPath = join(entryDir, `.rpc-bundle-${process.pid}.mjs`);
      writeFileSync(tmpPath, code);
      try {
        return await import(tmpPath);
      } finally {
        try { unlinkSync(tmpPath); } catch {}
      }
    }
  }
  return await import(entryPath);
}

// argv to spawn this binary (compiled) or this entry via bun (source run).
export function selfCommand(subcommand: string): string[] {
  const isCompiled = Bun.main.includes('$bunfs');
  return isCompiled
    ? [process.execPath, subcommand]
    : [process.execPath, 'run', Bun.main, subcommand];
}

export function parseLastJsonLine(stdout: string): any {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line); } catch {}
  }
  throw new Error(`no JSON response in subprocess output: ${stdout.slice(0, 200)}`);
}
