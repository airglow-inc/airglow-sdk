import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readdir, readFile, stat } from 'fs/promises';
import { readFileSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
// @ts-ignore — .mjs side-module
import { installNativeHost } from '../lib/native-host/install.mjs';
import { buildSdkCode } from '../lib/airglow-sdk';

const DEFAULT_PORT = 3001;
const SERVER_START = Date.now(); // unique per server restart
const CLI_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version; }
  catch { return 'unknown'; }
})();

// Chrome derives the unpacked extension ID by SHA-256-hashing the decoded `key`
// from manifest.json, taking the first 16 bytes, then mapping each hex digit
// '0'..'f' to 'a'..'p'. Returns null if the manifest or key is unavailable.
function deriveExtensionId(extensionDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
    if (typeof manifest.key !== 'string') return null;
    const der = Buffer.from(manifest.key, 'base64');
    const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
    return Array.from(hex).map(c => String.fromCharCode(parseInt(c, 16) + 97)).join('');
  } catch {
    return null;
  }
}

const ALLOWED_EXTENSION_ID = deriveExtensionId(join(process.cwd(), '..', 'extension'));

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // curl, scripts, server-to-server
  if (ALLOWED_EXTENSION_ID && origin === `chrome-extension://${ALLOWED_EXTENSION_ID}`) return true;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
  return false;
}

// ── Update-status check ──────────────────────────────────────────────────────
// Two independent signals:
//   - extension: hash baked into shipped extension/build-hash.txt vs hash of
//     extension/ on disk. Mismatch ⇒ user pulled but didn't reload extension.
//   - repo: local HEAD vs upstream HEAD. Behind ⇒ user should `git pull`.

const UPSTREAM_REMOTE = 'https://github.com/airglow-inc/airglow-sdk.git';
const UPSTREAM_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
let upstreamHeadCache: { sha: string | null; checkedAt: number; localHeadAtCheck: string | null } = { sha: null, checkedAt: 0, localHeadAtCheck: null };

function currentExtensionBuildHash(extensionDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
    return typeof manifest.airglow_build_hash === 'string' ? manifest.airglow_build_hash : null;
  } catch {
    return null;
  }
}

function localRepoHead(cwd: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd, timeout: 2000 }).trim();
  } catch {
    return null;
  }
}

function upstreamRepoHead(localHead: string | null): string | null {
  const now = Date.now();
  const fresh = now - upstreamHeadCache.checkedAt < UPSTREAM_CHECK_INTERVAL_MS;
  const localUnchanged = upstreamHeadCache.localHeadAtCheck === localHead;
  if (upstreamHeadCache.sha && fresh && localUnchanged) {
    return upstreamHeadCache.sha;
  }
  try {
    const out = execSync(`git ls-remote ${UPSTREAM_REMOTE} HEAD`, { encoding: 'utf-8', timeout: 5000 });
    const sha = out.split(/\s+/)[0] || null;
    upstreamHeadCache = { sha, checkedAt: now, localHeadAtCheck: localHead };
    return sha;
  } catch {
    upstreamHeadCache = { sha: null, checkedAt: now, localHeadAtCheck: localHead };
    return null;
  }
}

function handleUpdateStatus(extensionDir: string, loadedBuildHash: string | null) {
  const cwd = join(extensionDir, '..');
  const currentBuild = currentExtensionBuildHash(extensionDir);
  const localHead = localRepoHead(cwd);
  const upstreamHead = upstreamRepoHead(localHead);
  return {
    extension: {
      loaded: loadedBuildHash,
      current: currentBuild,
      needsReload: !!(loadedBuildHash && currentBuild && loadedBuildHash !== currentBuild),
    },
    repo: {
      local: localHead,
      upstream: upstreamHead,
      behindUpstream: !!(localHead && upstreamHead && localHead !== upstreamHead),
    },
  };
}

// ── Log tee ──
// Mirror stdout/stderr to .airglow/dev.log so the maintainer (or an agent) can
// read errors after the fact without scrollback. Truncated each run so the file
// represents the current session.
function setupLogTee(appsDir: string): string | null {
  try {
    const logDir = join(appsDir, '.airglow');
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, 'dev.log');
    const stream = createWriteStream(logPath, { flags: 'w' });
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    for (const fd of ['stdout', 'stderr'] as const) {
      const orig = process[fd].write.bind(process[fd]);
      process[fd].write = ((chunk: any, ...args: any[]) => {
        try {
          const s = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
          stream.write(stripAnsi(s));
        } catch {}
        return orig(chunk, ...args);
      }) as any;
    }
    return logPath;
  } catch {
    return null;
  }
}

// ── .env parsing ──
// Minimal `KEY=VALUE` parser. Lines starting with `#` or without `=` are skipped.
// Values are not unquoted; leading/trailing whitespace is trimmed.
function parseEnvFile(path: string): Record<string, string> {
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

function loadEnvFiles(paths: string[]): void {
  for (const p of paths) {
    const env = parseEnvFile(p);
    for (const [k, v] of Object.entries(env)) {
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}

// ── App server logic (standalone, no Next.js) ──

interface AppManifest {
  id: string;
  name: string;
  secrets?: Record<string, { label?: string } | true>;
  server_env?: Record<string, { label?: string } | true>;
  [key: string]: any;
}

// Check declared env keys (server_env + CLIENT_-prefixed secrets) against
// workspace + per-app .env files. Client secrets may also be set via the
// extension's Secrets UI; the CLI can't see that, so a warning here means
// "not in .env" — still useful at dev startup.
function findMissingEnv(appsDir: string, manifests: AppManifest[]): { lines: string[]; appsWithMissing: Set<string> } {
  const workspaceEnv = parseEnvFile(join(appsDir, '.env'));
  const lines: string[] = [];
  const appsWithMissing = new Set<string>();
  for (const m of manifests) {
    const appDir = appDirCache.get(m.id);
    const appEnv = appDir ? parseEnvFile(join(appDir, '.env')) : {};
    const appLines: string[] = [];
    const check = (envKey: string, decl: { label?: string } | true | undefined) => {
      if (envKey in workspaceEnv || envKey in appEnv || envKey in process.env) return;
      const label = decl && typeof decl === 'object' && decl.label ? ` — ${decl.label}` : '';
      appLines.push(`      ${envKey}${label}`);
    };
    if (m.secrets) {
      for (const [key, decl] of Object.entries(m.secrets)) check(`CLIENT_${key}`, decl);
    }
    if (m.server_env) {
      for (const [key, decl] of Object.entries(m.server_env)) check(key, decl);
    }
    if (appLines.length === 0) continue;
    appsWithMissing.add(m.id);
    lines.push(`    \x1b[1m${m.id}\x1b[22m`);
    lines.push(...appLines);
  }
  return { lines, appsWithMissing };
}

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.json', '.html']);

/** Recursively collect mtimes of source files in a dir */
async function collectMtimes(dir: string): Promise<number[]> {
  const mtimes: number[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        mtimes.push(...await collectMtimes(fullPath));
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

/** Compute per-app content hash from source file mtimes, folding in shared mtimes */
async function computeAppHash(appDir: string, sharedMtimes: number[]): Promise<string> {
  const mtimes = await collectMtimes(appDir);
  mtimes.push(...sharedMtimes);
  mtimes.push(Number(SERVER_START)); // changes on server restart
  return createHash('md5').update(mtimes.sort().join(',')).digest('hex').slice(0, 12);
}

// Cache appId → absolute app dir. Populated by scanManifests, consumed by
// every handler that needs to locate an app's files. Lets apps live anywhere
// under appsDir (e.g. `local/<id>` for maintainer dogfooding apps).
const appDirCache = new Map<string, string>();

async function scanManifestsInto(
  root: string,
  sharedMtimes: number[],
  out: AppManifest[],
  depth: number,
): Promise<void> {
  if (depth > 4) return;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === 'shared' || entry.name.startsWith('.')) continue;
    const appDir = join(root, entry.name);
    try {
      const raw = await readFile(join(appDir, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw);
      manifest._hash = await computeAppHash(appDir, sharedMtimes);
      if (manifest.id) appDirCache.set(manifest.id, appDir);
      out.push(manifest);
      // Found an app — don't descend further (apps don't contain apps).
    } catch {
      await scanManifestsInto(appDir, sharedMtimes, out, depth + 1);
    }
  }
}

async function scanManifests(appsDir: string): Promise<AppManifest[]> {
  try {
    const sharedMtimes = await collectMtimes(join(appsDir, 'shared'));
    const manifests: AppManifest[] = [];
    await scanManifestsInto(appsDir, sharedMtimes, manifests, 0);
    return manifests;
  } catch {
    return [];
  }
}

async function resolveAppDir(appsDir: string, appId: string): Promise<string | null> {
  const cached = appDirCache.get(appId);
  if (cached) {
    try { await stat(join(cached, 'manifest.json')); return cached; }
    catch { appDirCache.delete(appId); }
  }
  await scanManifests(appsDir);
  return appDirCache.get(appId) ?? null;
}

async function findUiEntry(uiDir: string): Promise<string | null> {
  for (const c of ['App.tsx', 'App.ts', 'App.jsx', 'App.js']) {
    try { await stat(join(uiDir, c)); return c; } catch {}
  }
  return null;
}

// Resolve esbuild binary from the workspace where pnpm install ran (airglow-apps/).
const esbuildBin = join(process.cwd(), 'node_modules', '.bin', 'esbuild');

function esbuild(entryPath: string, cwd: string, extraFlags = ''): string {
  return execSync(
    `${esbuildBin} ${entryPath} --bundle --target=es2022 --jsx=automatic --loader:.svg=text --loader:.txt=text --loader:.md=text ${extraFlags}`.trim(),
    { encoding: 'utf-8', timeout: 15000, cwd, maxBuffer: 10 * 1024 * 1024 },
  );
}

type BundleResult = { ok: true; code: string } | { ok: false; stderr: string; hint: string | null };

function bundle(entryPath: string, cwd: string, extraFlags = ''): BundleResult {
  try {
    return { ok: true, code: esbuild(entryPath, cwd, extraFlags) };
  } catch (e: any) {
    const raw: string = (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString?.() ?? '') || e.message || '';
    const stderr = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^Command failed:.*?\n/, '').trim();
    return { ok: false, stderr, hint: diagnoseEsbuildError(stderr) };
  }
}

function diagnoseEsbuildError(stderr: string): string | null {
  const missing = stderr.match(/Could not resolve "([^"]+)"/);
  if (missing) {
    const pkg = missing[1];
    if (pkg.startsWith('.') || pkg.startsWith('/')) {
      return `Missing local file: ${pkg}\n\nCheck the import path against your filesystem.`;
    }
    return `Package "${pkg}" is not installed.\n\nFix:\n  1. If "${pkg}" is already listed in the app's package.json: run "pnpm install" from the apps workspace root.\n  2. If not listed: run "pnpm add ${pkg} --filter <app-name>" from the apps workspace root.`;
  }
  const exportMatches = [...stderr.matchAll(/No matching export in "[^"]*" for import "([^"]+)"/g)];
  if (exportMatches.length) {
    const imports = [...new Set(exportMatches.map(m => m[1]))];
    const versioned = stderr.match(/\.pnpm\/((?:@[^/]+\+)?[^/]+@[^/_]+)/);
    const installedSuffix = versioned ? ` (currently installed: ${versioned[1].replace('+', '/')})` : '';
    return `Imports ${imports.join(', ')} not found in the installed package${installedSuffix}.\n\nThe installed version is too old or incompatible.\n\nFix:\n  1. Bump the version in the app's package.json (try the latest).\n  2. Run "pnpm install" from the apps workspace root.`;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
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
<details${hint ? '' : ' open'}><summary>esbuild output</summary><pre>${escapeHtml(stderr)}</pre></details>
</body></html>`;
}

// ── Route handlers ──

async function handleManifests(appsDir: string): Promise<[number, any]> {
  return [200, await scanManifests(appsDir)];
}

async function handleUi(appsDir: string, appId: string): Promise<[number, string, string]> {
  const appRoot = await resolveAppDir(appsDir, appId);
  if (!appRoot) return [404, 'application/json', JSON.stringify({ error: `app ${appId} not found` })];
  const uiDir = join(appRoot, 'ui');
  const entryFile = await findUiEntry(uiDir);
  if (!entryFile) return [404, 'application/json', JSON.stringify({ error: `no UI entry found for ${appId}` })];

  const result = bundle(join(uiDir, entryFile), appRoot);
  if (!result.ok) {
    console.error(`[airglow/${appId}] bundle failed${result.hint ? ` — ${result.hint.split('\n')[0]}` : ''}`);
    return [500, 'text/html; charset=utf-8', renderBundleErrorHtml(appId, result.stderr, result.hint)];
  }
  const bundled = result.code;

  let css = '';
  const cssPath = join(uiDir, 'globals.css');
  try {
    await stat(cssPath);
    css = execSync(
      `./node_modules/.bin/tailwindcss -i ${cssPath} --minify`,
      { encoding: 'utf-8', timeout: 15000, cwd: appsDir },
    );
  } catch {}
  if (!css) {
    try { css = await readFile(join(appsDir, 'shared/theme/tokens.css'), 'utf-8'); } catch {}
  }

  const sdkCode = buildSdkCode(appId);
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${appId}</title><style>${css}</style></head>
<body><div id="root"></div>
<script>${sdkCode}<\/script>
<script>window.__airglow_params = Object.fromEntries(new URLSearchParams(location.search));<\/script>
<script>${bundled}<\/script>
</body></html>`;
  return [200, 'text/html; charset=utf-8', html];
}

async function handleUiBundle(appsDir: string, appId: string): Promise<[number, string, string]> {
  const appRoot = await resolveAppDir(appsDir, appId);
  if (!appRoot) return [404, 'application/json', JSON.stringify({ error: `app ${appId} not found` })];
  const uiDir = join(appRoot, 'ui');
  const entryFile = await findUiEntry(uiDir);
  if (!entryFile) return [404, 'application/json', JSON.stringify({ error: `no UI entry found for ${appId}` })];
  const result = bundle(join(uiDir, entryFile), appRoot);
  if (!result.ok) {
    console.error(`[airglow/${appId}] ui-bundle failed${result.hint ? ` — ${result.hint.split('\n')[0]}` : ''}`);
    return [500, 'application/json', JSON.stringify({ error: 'bundle failed', hint: result.hint, stderr: result.stderr })];
  }
  return [200, 'text/javascript; charset=utf-8', result.code];
}

async function handleUserscript(appsDir: string, appId: string, file: string, format: string): Promise<[number, string, string]> {
  if (file.includes('..')) return [400, 'application/json', JSON.stringify({ error: 'invalid file path' })];
  const appRoot = await resolveAppDir(appsDir, appId);
  if (!appRoot) return [404, 'application/json', JSON.stringify({ error: `app ${appId} not found` })];
  const result = bundle(join(appRoot, file), appRoot, `--format=${format}`);
  if (!result.ok) {
    console.error(`[airglow/${appId}] userscript bundle failed${result.hint ? ` — ${result.hint.split('\n')[0]}` : ''}`);
    return [500, 'application/json', JSON.stringify({ error: 'bundle failed', hint: result.hint, stderr: result.stderr })];
  }
  return [200, 'text/javascript; charset=utf-8', result.code];
}

async function handleSettings(appsDir: string, appId: string): Promise<[number, any]> {
  const appRoot = await resolveAppDir(appsDir, appId);
  if (!appRoot) return [404, { error: `app ${appId} not found` }];
  const settings: Record<string, string> = {};
  for (const envPath of [join(appsDir, '.env'), join(appRoot, '.env')]) {
    try {
      const content = await readFile(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq);
        if (key.startsWith('CLIENT_')) settings[key.slice(7)] = trimmed.slice(eq + 1);
      }
    } catch {}
  }
  return [200, settings];
}

async function handleRpc(appsDir: string, appId: string, functionName: string, body: any): Promise<[number, any]> {
  const appRoot = await resolveAppDir(appsDir, appId);
  if (!appRoot) return [404, { error: `app ${appId} not found` }];
  const serverDir = join(appRoot, 'server');
  let entryFile = '';
  for (const ext of ['.ts', '.js']) {
    try { await stat(join(serverDir, `${functionName}${ext}`)); entryFile = `${functionName}${ext}`; break; } catch {}
  }
  if (!entryFile) return [404, { error: `server function '${functionName}' not found` }];

  const bundled = execSync(
    `${esbuildBin} ${join(serverDir, entryFile)} --bundle --platform=node --format=cjs --target=es2022`,
    { encoding: 'utf-8', timeout: 15000, cwd: appRoot, maxBuffer: 10 * 1024 * 1024 },
  );

  // Load .env vars into the real process.env so that libraries using
  // globalThis.process.env (e.g. Anthropic SDK, Composio SDK) pick them up.
  loadEnvFiles([join(appsDir, '.env'), join(appRoot, '.env')]);

  const envProxy = new Proxy(process.env, {
    get(target, prop: string) {
      const val = target[prop];
      if (val === undefined && !prop.startsWith('npm_') && prop !== 'TZ') {
        console.error(`[airglow/${appId}] process.env.${prop} is undefined — missing from .env?`);
      }
      return val;
    },
  });

  const nodeRequire = require('module').createRequire(join(appRoot, 'package.json'));
  const mod = { exports: {} as any };
  const fn = new Function('module', 'exports', 'require', 'process', bundled);
  fn(mod, mod.exports, nodeRequire, { ...process, env: envProxy });

  const handler = mod.exports.default || mod.exports[functionName];
  if (typeof handler !== 'function') return [500, { error: `'${functionName}' has no default or named export` }];

  const result = await handler(body);
  return [200, result];
}

// ── HTTP server ──

function parseUrl(url: string): { pathname: string; searchParams: URLSearchParams } {
  const u = new URL(url, 'http://localhost');
  return { pathname: u.pathname, searchParams: u.searchParams };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  try { return JSON.parse(raw); } catch { return {}; }
}

async function probeRunning(port: number): Promise<{ matched: boolean; sameWorkspace: boolean; appsDir?: string }> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 500);
    const res = await fetch(`http://127.0.0.1:${port}/api/healthz`, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return { matched: false, sameWorkspace: false };
    const data: any = await res.json();
    if (data?.service !== 'airglow-dev') return { matched: false, sameWorkspace: false };
    return { matched: true, sameWorkspace: false, appsDir: data.appsDir };
  } catch {
    return { matched: false, sameWorkspace: false };
  }
}

// Probe the native-host port (3101). Returns:
//   'ours'     — our spy host is responding (extension connected, all good)
//   'foreign'  — something is bound to the port but isn't the spy host
//   'free'     — nothing on the port (Chrome may not be running yet; not a problem)
async function probeSpyPort(): Promise<'ours' | 'foreign' | 'free'> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 500);
    const res = await fetch('http://127.0.0.1:3101/status', { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return 'foreign';
    const data: any = await res.json();
    return data?.service === 'airglow-spy' ? 'ours' : 'foreign';
  } catch (e: any) {
    if (e?.cause?.code === 'ECONNREFUSED') return 'free';
    return 'foreign';
  }
}

export async function dev(opts: { port?: number; appsDir?: string } = {}) {
  const appsDir = opts.appsDir ? (opts.appsDir.startsWith('/') ? opts.appsDir : join(process.cwd(), opts.appsDir)) : process.cwd();
  const port = opts.port ?? DEFAULT_PORT;

  const probe = await probeRunning(port);
  if (probe.matched) {
    if (probe.appsDir === appsDir) {
      console.log(`\n  \x1b[1mairglow dev\x1b[0m is already running on http://127.0.0.1:${port}\n`);
      process.exit(0);
    }
    console.error(`\n  Another airglow dev server is running on :${port}`);
    console.error(`    its workspace:  ${probe.appsDir}`);
    console.error(`    this workspace: ${appsDir}\n`);
    console.error(`  Stop the other server, or pass --port.\n`);
    process.exit(1);
  }

  const logPath = setupLogTee(appsDir);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname, searchParams } = parseUrl(req.url || '/');

    // CORS headers for extension
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Reject requests from browser origins we don't expect. Allowed:
    //   - chrome-extension://<our extension id>  (the Airglow extension)
    //   - http://127.0.0.1:* / http://localhost:* (developer previewing in a tab)
    //   - empty Origin                            (curl, scripts, server-to-server)
    if (!originAllowed(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin not allowed', origin: req.headers.origin }));
      return;
    }

    try {
      if (pathname === '/api/healthz' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'airglow-dev', version: CLI_VERSION, appsDir }));
        return;
      }

      if (pathname === '/api/extension/update-status' && req.method === 'GET') {
        const loadedHash = searchParams.get('extensionBuildHash');
        const data = handleUpdateStatus(join(appsDir, '..', 'extension'), loadedHash);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (pathname === '/api/apps/manifests' && req.method === 'GET') {
        const [status, data] = await handleManifests(appsDir);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      // Match /api/apps/:appId/...
      const appMatch = pathname.match(/^\/api\/apps\/([^/]+)\/(.+)$/);
      if (appMatch) {
        const [, appId, rest] = appMatch;

        if (rest === 'ui' && req.method === 'GET') {
          const [status, contentType, body] = await handleUi(appsDir, appId);
          res.writeHead(status, { 'Content-Type': contentType });
          res.end(body);
          return;
        }

        if (rest === 'ui-bundle' && req.method === 'GET') {
          const [status, contentType, body] = await handleUiBundle(appsDir, appId);
          res.writeHead(status, { 'Content-Type': contentType });
          res.end(body);
          return;
        }

        if (rest === 'userscript' && req.method === 'GET') {
          const file = searchParams.get('file');
          if (!file) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing file param' })); return; }
          const format = searchParams.get('format') || 'iife';
          const [status, contentType, body] = await handleUserscript(appsDir, appId, file, format);
          res.writeHead(status, { 'Content-Type': contentType });
          res.end(body);
          return;
        }

        if (rest === 'settings' && req.method === 'GET') {
          const [status, data] = await handleSettings(appsDir, appId);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
          return;
        }

        // POST /api/apps/:appId/rpc/:functionName
        const rpcMatch = rest.match(/^rpc\/(.+)$/);
        if (rpcMatch && req.method === 'POST') {
          const body = await readBody(req);
          const [status, data] = await handleRpc(appsDir, appId, rpcMatch[1], body);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
          return;
        }
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  \x1b[1mPort ${port} is in use by another process\x1b[0m (not airglow dev).`);
      console.error(`  Stop it, or pass --port.\n`);
    } else {
      console.error(`  Failed to start: ${err.message}`);
    }
    process.exit(1);
  });
  server.on('listening', async () => {
    try { installNativeHost({ quiet: false }); }
    catch (e: any) { console.error(`  [airglow] native host install failed: ${e.message}`); }
    const manifests = await scanManifests(appsDir);
    console.log(`\n  airglow dev server running on http://127.0.0.1:${port}\n`);
    console.log(`  \x1b[1mSet dev port to ${port} in the extension dashboard.\x1b[0m\n`);
    if (logPath) console.log(`  Logs: ${logPath}\n`);
    if (await probeSpyPort() === 'foreign') {
      console.log(`  \x1b[1;31mWarning — port 3101 is in use by another process.\x1b[0m`);
      console.log(`  The extension's logs endpoint and CDP network capture won't work until it's freed.\n`);
    }
    if (manifests.length === 0) {
      console.log('  No apps found. Create one with: airglow new <id>\n');
    } else {
      const { lines: missing, appsWithMissing } = findMissingEnv(appsDir, manifests);
      console.log(`  \x1b[1mServing ${manifests.length} app(s):\x1b[22m`);
      for (const m of manifests) {
        const prefix = appsWithMissing.has(m.id) ? `\x1b[1;31m(!)\x1b[0m ` : `    `;
        console.log(`  ${prefix}${m.id} — ${m.name}`);
      }
      console.log();
      if (missing.length > 0) {
        console.log(`  \x1b[1;31mWarning — missing env vars (declared in manifest.secrets / manifest.server_env):\x1b[0m`);
        for (const line of missing) console.log(line);
        console.log();
        console.log(`  Set them in airglow-apps/.env or airglow-apps/<app>/.env\n`);
      }
    }
  });

  server.listen(port, '127.0.0.1');
}
