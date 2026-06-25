// App server — serves workspace apps to the extension (manifests, bundles, RPC).
// Scans the workspace for apps, bundles userscripts/UI with Bun.build, serves
// manifests/settings, and executes server functions in-process.

import { readdir, readFile, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { buildSdkCode } from '../../../sdk/airglow-sdk';
import { parseLastJsonLine, selfCommand } from '../internal';

const SERVER_START = Date.now(); // folded into hashes — daemon restart busts caches
const FAILED_BUNDLE_TTL_MS = 5_000; // a failed bundle is re-attempted at most this often

type BundleResult = { ok: true; code: string } | { ok: false; stderr: string; hint: string | null };

export interface AppManifest {
  id: string;
  name: string;
  server_env?: Record<string, { label?: string } | true>;
  [key: string]: any;
}

// Directories that are never apps. `state`/`bin`/`docs` are daemon-managed,
// `shared` is the managed asset dir apps import from.
const SKIP_DIRS = new Set(['node_modules', 'shared', 'state', 'bin', 'docs']);

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.json', '.html']);

export class AppServer {
  // appId → absolute app dir. Populated by scanManifests, consumed by every
  // handler that needs to locate an app's files.
  private appDirCache = new Map<string, string>();

  // Set by the daemon once the HTTP server is listening; server functions get
  // it as AIRGLOW_DAEMON_ORIGIN so the server-side SDK can call back in.
  daemonOrigin: (() => string) | null = null;

  constructor(readonly workspace: string) {}

  // ── .env ──

  parseEnvFile(path: string): Record<string, string> {
    const out: Record<string, string> = {};
    let content: string;
    try { content = readFileSync(path, 'utf-8'); }
    catch { return out; }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
  }

  // ── Scanning & hashing ──

  private async collectMtimes(dir: string): Promise<number[]> {
    const mtimes: number[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          mtimes.push(...await this.collectMtimes(fullPath));
        } else {
          const ext = entry.name.slice(entry.name.lastIndexOf('.'));
          if (!SOURCE_EXTS.has(ext)) continue;
          const s = await stat(fullPath);
          mtimes.push(s.mtimeMs);
        }
      }
    } catch {}
    return mtimes;
  }

  private async computeAppHash(appDir: string, sharedMtimes: number[]): Promise<string> {
    const mtimes = await this.collectMtimes(appDir);
    mtimes.push(...sharedMtimes);
    mtimes.push(SERVER_START);
    return createHash('md5').update(mtimes.sort().join(',')).digest('hex').slice(0, 12);
  }

  private async listServerFunctions(appDir: string): Promise<string[]> {
    try {
      const entries = await readdir(join(appDir, 'server'), { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.startsWith('.'))
        .map((e) => e.name.slice(0, -3))
        .sort();
    } catch {
      return [];
    }
  }

  private async findUiEntry(uiDir: string): Promise<string | null> {
    for (const c of ['App.tsx', 'App.ts', 'App.jsx', 'App.js']) {
      try { await stat(join(uiDir, c)); return c; } catch {}
    }
    return null;
  }

  private async scanInto(root: string, sharedMtimes: number[], out: AppManifest[], depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const appDir = join(root, entry.name);
      try {
        const raw = await readFile(join(appDir, 'manifest.json'), 'utf-8');
        const manifest = JSON.parse(raw);
        manifest._hash = await this.computeAppHash(appDir, sharedMtimes);
        // Every app has at least the shared default page, so _hasUi is true
        // whenever the app ships its own ui/ or the default page is available.
        manifest._hasUi = (await this.findUiEntry(join(appDir, 'ui'))) !== null
          || existsSync(join(this.workspace, 'shared', 'default-ui', 'index.tsx'));
        manifest._serverFunctions = await this.listServerFunctions(appDir);
        if (manifest.id) this.appDirCache.set(manifest.id, appDir);
        out.push(manifest);
        // Found an app — don't descend further (apps don't contain apps).
      } catch {
        await this.scanInto(appDir, sharedMtimes, out, depth + 1);
      }
    }
  }

  async scanManifests(): Promise<AppManifest[]> {
    try {
      const sharedMtimes = await this.collectMtimes(join(this.workspace, 'shared'));
      const manifests: AppManifest[] = [];
      await this.scanInto(this.workspace, sharedMtimes, manifests, 0);
      return manifests;
    } catch {
      return [];
    }
  }

  async resolveAppDir(appId: string): Promise<string | null> {
    const cached = this.appDirCache.get(appId);
    if (cached) {
      try { await stat(join(cached, 'manifest.json')); return cached; }
      catch { this.appDirCache.delete(appId); }
    }
    await this.scanManifests();
    return this.appDirCache.get(appId) ?? null;
  }

  // ── Bundling ──
  // Runs in a fresh subprocess of this same binary (`internal-build`): Bun
  // caches negative module resolutions per process, so bundling in the
  // long-lived daemon would never see packages installed after daemon start.
  //
  // A cold Bun.build is the daemon's one CPU-heavy operation. Three guards keep
  // it from melting the box when many browsers re-request an app's bundles at
  // once — which happens on every extension reload and on every file the
  // in-product agent saves while iterating on an app (each save busts the app
  // hash → every connected browser re-registers all its userscripts):
  //   1. result cache — a bundle is reused until any source file in the app
  //      changes (mtime signature, SERVER_START-scoped like the manifest hash,
  //      so a daemon restart busts it). Steady-state requests cost a stat-walk,
  //      not a build.
  //   2. in-flight dedup — concurrent identical requests share one build, so N
  //      browsers asking for the same userscript spawn one process, not N.
  //   3. concurrency cap — at most MAX_BUILDS cold builds run at once, so a cold
  //      cache (fresh daemon, or an app with many userscripts) can't fork-bomb
  //      every core.
  // Without these, a build that loses the CPU race exceeds its 30s timeout →
  // the extension retries → more builds → a self-feeding storm that starves
  // native-messaging connector startup and reads as "Host offline" everywhere.
  private bundleCache = new Map<string, { sig: string; result: BundleResult }>();
  private bundleInflight = new Map<string, { sig: string; promise: Promise<BundleResult> }>();
  private activeBuilds = 0;
  private buildWaiters: Array<() => void> = [];
  private readonly MAX_BUILDS = Math.max(2, Math.floor((cpus().length || 4) / 2));

  // Cache freshness key for an app's bundles. Deliberately the SAME value as the
  // manifest `_hash` (app source mtimes + shared/ mtimes + SERVER_START): the
  // extension re-registers an app's userscripts exactly when its `_hash` changes,
  // so keying the bundle cache identically means a re-registration always misses
  // the cache (fresh build) and an unchanged app always hits it — including edits
  // to shared/ files a userscript imports. node_modules/dotfiles are skipped by
  // collectMtimes, so this is a cheap stat-walk, not a build.
  private async bundleSig(appRoot: string): Promise<string> {
    const sharedMtimes = await this.collectMtimes(join(this.workspace, 'shared'));
    return this.computeAppHash(appRoot, sharedMtimes);
  }

  private async acquireBuildSlot(): Promise<void> {
    if (this.activeBuilds < this.MAX_BUILDS) { this.activeBuilds++; return; }
    await new Promise<void>((resolve) => this.buildWaiters.push(resolve));
    this.activeBuilds++;
  }
  private releaseBuildSlot(): void {
    this.activeBuilds--;
    this.buildWaiters.shift()?.();
  }

  private async bundle(
    entryPath: string,
    format: 'iife' | 'esm',
    appRoot: string,
  ): Promise<BundleResult> {
    const key = `${entryPath} ${format}`;
    const sig = await this.bundleSig(appRoot);

    const cached = this.bundleCache.get(key);
    if (cached && cached.sig === sig) return cached.result;

    const inflight = this.bundleInflight.get(key);
    if (inflight && inflight.sig === sig) return inflight.promise;

    const promise = (async (): Promise<BundleResult> => {
      await this.acquireBuildSlot();
      try {
        return await this.runBundle(entryPath, format);
      } finally {
        this.releaseBuildSlot();
      }
    })().then((result) => {
      this.bundleCache.set(key, { sig, result });
      // Failures expire after a short TTL: a genuinely-broken bundle isn't
      // rebuilt on every 3s retry, but a transient failure (a build that lost a
      // CPU race) still recovers without waiting for the next source edit.
      if (!result.ok) {
        const timer = setTimeout(() => {
          const c = this.bundleCache.get(key);
          if (c && c.sig === sig && !c.result.ok) this.bundleCache.delete(key);
        }, FAILED_BUNDLE_TTL_MS);
        (timer as any).unref?.();
      }
      if (this.bundleInflight.get(key)?.promise === promise) this.bundleInflight.delete(key);
      return result;
    });

    this.bundleInflight.set(key, { sig, promise });
    return promise;
  }

  private async runBundle(
    entryPath: string,
    format: 'iife' | 'esm',
  ): Promise<BundleResult> {
    try {
      const proc = Bun.spawn(selfCommand('internal-build'), {
        cwd: this.workspace,
        stdin: new Blob([JSON.stringify({ entrypoint: entryPath, format })]),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode !== 0) {
        return { ok: false, stderr: `bundler subprocess exited ${exitCode}`, hint: null };
      }
      const res = parseLastJsonLine(stdout);
      if (!res.ok) {
        return { ok: false, stderr: String(res.stderr ?? 'unknown bundler error'), hint: diagnoseBundleError(String(res.stderr ?? '')) };
      }
      return { ok: true, code: String(res.code) };
    } catch (e: any) {
      const stderr = String(e?.message || e);
      return { ok: false, stderr, hint: diagnoseBundleError(stderr) };
    }
  }

  // ── Route handlers ──
  // Same [status, contentType, body] shapes as the old dev server so the
  // extension-side contract is unchanged.

  async handleManifests(): Promise<[number, any]> {
    return [200, await this.scanManifests()];
  }

  async handleUi(appId: string): Promise<[number, string, string]> {
    const appRoot = await this.resolveAppDir(appId);
    if (!appRoot) return [404, 'application/json', JSON.stringify({ error: `app ${appId} not found` })];
    const uiDir = join(appRoot, 'ui');
    const entryFile = await this.findUiEntry(uiDir);

    // Apps that ship no ui/ fall back to the shared default page — the standard
    // AppPage header + overview — so every app has a settings/overview surface.
    let entryPath: string;
    let cssPath: string;
    let appIdInject = '';
    if (entryFile) {
      entryPath = join(uiDir, entryFile);
      cssPath = join(uiDir, 'globals.css');
    } else {
      const defaultDir = join(this.workspace, 'shared', 'default-ui');
      entryPath = join(defaultDir, 'index.tsx');
      if (!existsSync(entryPath)) {
        return [404, 'application/json', JSON.stringify({ error: `no UI entry found for ${appId}` })];
      }
      cssPath = join(defaultDir, 'globals.css');
      appIdInject = `<script>window.__airglow_app_id=${JSON.stringify(appId)};<\/script>`;
    }

    const result = await this.bundle(entryPath, 'iife', appRoot);
    if (!result.ok) {
      console.error(`[airglow/${appId}] bundle failed${result.hint ? ` — ${result.hint.split('\n')[0]}` : ''}`);
      return [500, 'text/html; charset=utf-8', renderBundleErrorHtml(appId, result.stderr, result.hint)];
    }

    let css = '';
    if (existsSync(cssPath)) {
      css = await this.buildTailwind(cssPath, appId, appRoot);
    }
    if (!css) {
      try { css = await readFile(join(this.workspace, 'shared/theme/tokens.css'), 'utf-8'); } catch {}
    }

    const sdkCode = buildSdkCode(appId, 'app_ui');
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${appId}</title><style>${AIRGLOW_BASE_CSS}</style><style>${css}</style></head>
<body><div id="root"></div>
${appIdInject}<script>${escapeInlineScript(sdkCode)}<\/script>
<script>window.__airglow_params = Object.fromEntries(new URLSearchParams(location.search));<\/script>
<script>${escapeInlineScript(result.code)}<\/script>
<script>${AIRGLOW_EMBED_RESIZE_JS}<\/script>
</body></html>`;
    return [200, 'text/html; charset=utf-8', html];
  }

  private tailwindCache = new Map<string, { sig: string; css: string }>();
  private tailwindInflight = new Map<string, { sig: string; promise: Promise<string> }>();

  // Compile an app's Tailwind CSS. Cached + deduped + slot-capped exactly like
  // bundle(): the CLI is a cold, multi-second, all-cores process (it scans the
  // app sources for utility classes). Running it per UI request — and worse,
  // synchronously via spawnSync, which froze the daemon's event loop for the
  // whole build — was a prime cause of the "daemon keeps going down" storm.
  private async buildTailwind(cssPath: string, appId: string, appRoot: string): Promise<string> {
    const sig = await this.bundleSig(appRoot);
    const cached = this.tailwindCache.get(cssPath);
    if (cached && cached.sig === sig) return cached.css;
    const inflight = this.tailwindInflight.get(cssPath);
    if (inflight && inflight.sig === sig) return inflight.promise;

    const promise = this.runTailwind(cssPath, appId).then((css) => {
      this.tailwindCache.set(cssPath, { sig, css });
      if (this.tailwindInflight.get(cssPath)?.promise === promise) this.tailwindInflight.delete(cssPath);
      return css;
    });
    this.tailwindInflight.set(cssPath, { sig, promise });
    return promise;
  }

  private async runTailwind(cssPath: string, appId: string): Promise<string> {
    const bin = join(this.workspace, 'node_modules', '.bin', 'tailwindcss');
    if (!existsSync(bin)) {
      console.error(`[airglow/${appId}] tailwindcss not installed in workspace — run \`bun install\` in ${this.workspace}`);
      return '';
    }
    // Tailwind ignores tsconfig `paths`, so resolve the `@shared/` alias here:
    // rewrite it to the absolute workspace shared/ path in a temp file next to
    // globals.css (keeps other relative @imports — e.g. "tailwindcss" — intact).
    let inputPath = cssPath;
    let tempPath = '';
    try {
      const css = readFileSync(cssPath, 'utf-8');
      if (css.includes('@shared/')) {
        const sharedAbs = join(this.workspace, 'shared') + '/';
        tempPath = join(dirname(cssPath), '.airglow-resolved.css');
        writeFileSync(tempPath, css.replaceAll('@shared/', sharedAbs));
        inputPath = tempPath;
      }
    } catch {}
    // The `.bin/tailwindcss` shim is a `#!/usr/bin/env node` script, but the
    // daemon runs under Bun in an environment without `node` on PATH (it's
    // launched by the native connector), so invoking the shim directly fails
    // with "env: node: No such file or directory" and we silently lose every
    // utility class. Run the resolved CLI entry with the Bun executable itself
    // instead — BUN_BE_BUN makes a compiled `airglow` binary act as plain bun
    // (no-op for source runs).
    let cli = bin;
    try { cli = realpathSync(bin); } catch {}
    await this.acquireBuildSlot();
    try {
      const proc = Bun.spawn([process.execPath, cli, '-i', inputPath, '--minify'], {
        cwd: this.workspace,
        env: { ...process.env, BUN_BE_BUN: '1' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        console.error(`[airglow/${appId}] tailwind build failed for ${cssPath}\n${stderr.trim()}`);
        return '';
      }
      return stdout;
    } finally {
      if (tempPath) { try { unlinkSync(tempPath); } catch {} }
      this.releaseBuildSlot();
    }
  }

  async handleUiBundle(appId: string): Promise<[number, string, string]> {
    const appRoot = await this.resolveAppDir(appId);
    if (!appRoot) return [404, 'application/json', JSON.stringify({ error: `app ${appId} not found` })];
    const uiDir = join(appRoot, 'ui');
    const entryFile = await this.findUiEntry(uiDir);
    if (!entryFile) return [404, 'application/json', JSON.stringify({ error: `no UI entry found for ${appId}` })];
    const result = await this.bundle(join(uiDir, entryFile), 'iife', appRoot);
    if (!result.ok) {
      console.error(`[airglow/${appId}] ui-bundle failed${result.hint ? ` — ${result.hint.split('\n')[0]}` : ''}`);
      return [500, 'application/json', JSON.stringify({ error: 'bundle failed', hint: result.hint, stderr: result.stderr })];
    }
    return [200, 'text/javascript; charset=utf-8', result.code];
  }

  async handleUserscript(appId: string, file: string, format: string): Promise<[number, string, string]> {
    if (file.includes('..')) return [400, 'application/json', JSON.stringify({ error: 'invalid file path' })];
    const appRoot = await this.resolveAppDir(appId);
    if (!appRoot) return [404, 'application/json', JSON.stringify({ error: `app ${appId} not found` })];
    const result = await this.bundle(join(appRoot, file), format === 'esm' ? 'esm' : 'iife', appRoot);
    if (!result.ok) {
      console.error(`[airglow/${appId}] userscript bundle failed${result.hint ? ` — ${result.hint.split('\n')[0]}` : ''}`);
      return [500, 'application/json', JSON.stringify({ error: 'bundle failed', hint: result.hint, stderr: result.stderr })];
    }
    return [200, 'text/javascript; charset=utf-8', result.code];
  }

  async handleRpc(
    appId: string,
    functionName: string,
    body: any,
    // Opaque per-RPC nonce identifying the invoking browser. Forwarded to the
    // subprocess so its airglow.connectors / airglow.llm loopbacks resolve the
    // right user (see rpcConnectorIdentities in daemon/index.ts).
    connectorSession?: string,
  ): Promise<[number, any]> {
    if (!/^[\w-]+$/.test(functionName)) return [400, { error: 'invalid function name' }];
    const appRoot = await this.resolveAppDir(appId);
    if (!appRoot) return [404, { error: `app ${appId} not found` }];
    const serverDir = join(appRoot, 'server');
    let entryPath = '';
    for (const ext of ['.ts', '.js']) {
      const p = join(serverDir, `${functionName}${ext}`);
      if (existsSync(p)) { entryPath = p; break; }
    }
    if (!entryPath) return [404, { error: `server function '${functionName}' not found` }];

    // Fresh subprocess per call (`internal-rpc`): fresh module resolver (sees
    // newly installed packages), fresh module cache (edits always take
    // effect), and env loaded without polluting the daemon's env. The loader
    // is first-wins, so the order IS the precedence: UI-entered secrets >
    // per-app .env. No workspace .env or process.env fallback.
    const proc = Bun.spawn(selfCommand('internal-rpc'), {
      cwd: appRoot,
      env: {
        ...process.env,
        AIRGLOW_APP_ID: appId,
        ...(this.daemonOrigin ? { AIRGLOW_DAEMON_ORIGIN: this.daemonOrigin() } : {}),
        ...(connectorSession ? { AIRGLOW_CONNECTOR_SESSION: connectorSession } : {}),
      },
      stdin: new Blob([JSON.stringify({
        entryPath,
        functionName,
        body,
        envFiles: [this.uiSecretsPath(appId), join(appRoot, '.env')],
      })]),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Server-function console output (rebound to stderr by the runner) goes
    // to the daemon log for debugging.
    if (stderr.trim()) console.log(`[airglow/${appId}/${functionName}]`, stderr.trim().slice(0, 2000));
    if (exitCode !== 0) return [500, { error: `server function crashed (exit ${exitCode})` }];
    const res = parseLastJsonLine(stdout);
    if (!res.ok) return [500, { error: String(res.error ?? 'server function failed') }];
    return [200, res.result];
  }

  // UI-entered secrets live in a daemon-owned per-app file, outside the app
  // directory — they survive app re-downloads and the agent never touches
  // state/. Highest precedence in env resolution.
  private uiSecretsPath(appId: string): string {
    return join(this.workspace, 'state', 'secrets', `${appId}.env`);
  }

  // Per-app status of declared env keys (manifest.server_env), resolved as
  // UI store > per-app .env. Values never leave the daemon — only set-ness,
  // the value's source, and a masked tail. Consumed by the startup warning,
  // the dashboard Secrets UI, and the chat missing-keys card.
  envStatus(manifests: AppManifest[]): AppEnvStatus[] {
    const out: AppEnvStatus[] = [];
    for (const m of manifests) {
      const decls = Object.entries(m.server_env ?? {});
      if (decls.length === 0) continue;
      const appDir = this.appDirCache.get(m.id);
      const appEnv = appDir ? this.parseEnvFile(join(appDir, '.env')) : {};
      const uiEnv = this.parseEnvFile(this.uiSecretsPath(m.id));
      const keys = decls.map(([key, decl]): AppEnvKey => {
        const uiValue = uiEnv[key];
        const envValue = appEnv[key];
        const value = uiValue ?? envValue;
        return {
          key,
          label: decl && typeof decl === 'object' ? decl.label : undefined,
          set: value !== undefined,
          source: uiValue !== undefined ? 'ui' : envValue !== undefined ? 'env' : undefined,
          maskedTail: value !== undefined ? maskTail(value) : undefined,
        };
      });
      out.push({ appId: m.id, name: m.name || m.id, keys });
    }
    return out;
  }

  // Write UI-entered secrets for one app ('' deletes a key).
  setAppSecrets(appId: string, entries: Record<string, string>): void {
    const path = this.uiSecretsPath(appId);
    mkdirSync(dirname(path), { recursive: true });
    mergeEnvFile(path, entries);
  }

  // Resolve one declared key's current value (UI store > app .env) for the
  // reveal-after-save affordance. Local-only: the value returns to the
  // same-origin app page on this machine — the same surface that wrote it.
  revealSecret(appId: string, key: string): string | null {
    const appDir = this.appDirCache.get(appId);
    const appEnv = appDir ? this.parseEnvFile(join(appDir, '.env')) : {};
    const uiEnv = this.parseEnvFile(this.uiSecretsPath(appId));
    return uiEnv[key] ?? appEnv[key] ?? null;
  }
}

export interface AppEnvKey {
  key: string;
  label?: string;
  set: boolean;
  // 'ui' = set via the Secrets UI (daemon-owned store), 'env' = the app's
  // own apps/<id>/.env file. Unset keys have no source.
  source?: 'ui' | 'env';
  maskedTail?: string;
}

export interface AppEnvStatus {
  appId: string;
  name: string;
  keys: AppEnvKey[];
}

// Line-level merge: replace existing KEY= lines, append new keys, drop keys
// set to ''. Comments and unrelated lines survive.
function mergeEnvFile(path: string, entries: Record<string, string>): void {
  let lines: string[] = [];
  try { lines = readFileSync(path, 'utf-8').split('\n'); } catch {}
  // Trim a single trailing blank line so appends don't accumulate gaps.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(Object.entries(entries));
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = m?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      if (value !== '') out.push(`${key}=${value}`);
      // '' → line dropped
    } else {
      out.push(line);
    }
  }
  for (const [key, value] of pending) {
    if (value !== '') out.push(`${key}=${value}`);
  }
  writeFileSync(path, out.length ? out.join('\n') + '\n' : '');
}

// Last 4 chars for values long enough that the tail reveals nothing.
function maskTail(value: string): string | undefined {
  return value.length >= 8 ? `…${value.slice(-4)}` : undefined;
}

function diagnoseBundleError(stderr: string): string | null {
  const missing = stderr.match(/Could not resolve[:]? "([^"]+)"/i);
  if (missing) {
    const pkg = missing[1];
    if (pkg.startsWith('.') || pkg.startsWith('/')) {
      return `Missing local file: ${pkg}\n\nCheck the import path against your filesystem.`;
    }
    return `Package "${pkg}" is not installed.\n\nFix:\n  1. If "${pkg}" is already in the app's package.json: run "bun install" from the workspace root.\n  2. If not: run "bun add ${pkg}" inside the app's directory.`;
  }
  const exportMatches = [...stderr.matchAll(/No matching export in "[^"]*" for import "([^"]+)"/g)];
  if (exportMatches.length) {
    const imports = [...new Set(exportMatches.map((m) => m[1]))];
    return `Imports ${imports.join(', ')} not found in the installed package.\n\nThe installed version is too old or incompatible.\n\nFix:\n  1. Bump the version in the app's package.json (try the latest).\n  2. Run "bun install" from the workspace root.`;
  }
  return null;
}

// A literal `</script>` inside an inline script (React DOM's dev build ships
// one in a string) terminates the tag early and the rest of the bundle
// renders as page text. esbuild escaped this in its output; Bun.build does
// not, so escape at embed time. `</script` can only legally occur inside JS
// strings/comments, where the backslash is a no-op escape — same trick
// esbuild and Vite use.
function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

function renderBundleErrorHtml(appId: string, stderr: string, hint: string | null): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(appId)} — bundle error</title>
<style>
  body { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 0; padding: 24px; background: #1a1a1a; color: #e0e0e0; }
  h1 { color: #ff6b6b; font-size: 15px; margin: 0 0 8px; font-weight: 600; }
  .sub { color: #888; font-size: 12px; margin-bottom: 16px; }
  .hint { background: #1f2d1f; border-left: 3px solid #4caf50; padding: 12px 14px; margin: 0 0 16px; white-space: pre-wrap; color: #cfe8d0; border-radius: 0 4px 4px 0; }
  details { margin-top: 8px; }
  summary { color: #888; cursor: pointer; font-size: 12px; padding: 4px 0; }
  pre { background: #0d0d0d; padding: 12px; margin: 8px 0 0; overflow: auto; white-space: pre-wrap; word-break: break-word; border-radius: 4px; color: #d4d4d4; }
</style></head><body>
<h1>Bundle error</h1>
<div class="sub">App: ${escapeHtml(appId)}</div>
${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''}
<details${hint ? '' : ' open'}><summary>bundler output</summary><pre>${escapeHtml(stderr)}</pre></details>
</body></html>`;
}

// Base CSS prepended to every UI HTML page so apps inherit Inter / JetBrains
// Mono and a basic reset. Kept in sync with extension/lib/airglow-base.css
// — the difference is the woff2 URL (/api/fonts/ here, /fonts/ on extension pages).
// Embedded app UIs report their content height to the dashboard so the iframe
// can size to fit and scroll with the page (rather than the dashboard pinning a
// fixed-viewport iframe with its own internal scroll). Guarded to the embedded
// case; deduped so resizing the iframe doesn't feed back into a resize loop.
const AIRGLOW_EMBED_RESIZE_JS = `(function(){
  if (window.parent === window) return;
  var last = 0;
  function report(){
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (h !== last) { last = h; parent.postMessage({ _airglow_height: h }, '*'); }
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(report);
    ro.observe(document.documentElement);
    ro.observe(document.body);
  }
  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  report();

  // Auto-height embed ('_embed=fit'): the iframe is sized to its content, so it
  // has no scroll of its own and the dashboard page is the scroller. Cross-origin
  // iframes don't reliably chain wheel scrolling to the parent — and a sub-pixel
  // height mismatch latches the gesture inside the iframe (the "stuck scroll") —
  // so forward wheel to the dashboard, unless an inner scroll container can
  // consume it in that direction (then let it scroll natively).
  if (/[?&]_embed=fit(&|$)/.test(location.search)) {
    window.addEventListener('wheel', function(e){
      var node = e.target;
      while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
        var st = getComputedStyle(node);
        if (e.deltaY && (st.overflowY === 'auto' || st.overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
          var atTop = node.scrollTop <= 0;
          var atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
          if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
        }
        if (e.deltaX && (st.overflowX === 'auto' || st.overflowX === 'scroll') && node.scrollWidth > node.clientWidth) {
          var atLeft = node.scrollLeft <= 0;
          var atRight = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
          if ((e.deltaX < 0 && !atLeft) || (e.deltaX > 0 && !atRight)) return;
        }
        node = node.parentNode;
      }
      e.preventDefault();
      parent.postMessage({ _airglow_wheel: { x: e.deltaX, y: e.deltaY, mode: e.deltaMode } }, '*');
    }, { passive: false });
  }
})();`;

const AIRGLOW_BASE_CSS = `
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; font-display: swap; src: url('/api/fonts/inter-variable.woff2') format('woff2-variations'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 100 800; font-display: swap; src: url('/api/fonts/jetbrains-mono-variable.woff2') format('woff2-variations'); }
*, *::before, *::after { box-sizing: border-box; }
body { font-family: var(--font-sans, 'Inter', system-ui, sans-serif); }
button, input, textarea, select { font-family: inherit; }
code, kbd, samp, pre { font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace); }
`;
