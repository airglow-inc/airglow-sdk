// Catalog install — fetches an app from the airglow-catalog source into the
// workspace's apps/<id>, then records provenance so the dashboard can tell
// catalog apps from local ones, flag updates, and flag local modifications.
//
// Source (AIRGLOW_CATALOG_DIR overrides):
//   - dev (source run) → sibling ../airglow-catalog checkout, copied directly
//   - prod            → GitHub tarball of airglow-inc/airglow-catalog, extracted
//
// Provenance lives in a daemon-owned sidecar (state/catalog/<id>.json) — never
// in the app's manifest — so the catalog copy stays pristine and "locally
// modified" stays detectable (install-time content hash vs current).

import { join, relative } from 'node:path';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import type { AppServer } from './apps';
import { dedupeAppDeps } from './dedupe-deps';

export interface CatalogProvenance {
  appId: string;
  catalogVersion: string; // manifest version at install time
  installedAt: string;
  modified: boolean; // current app files differ from the install
}

const APP_ID = /^[a-z0-9][a-z0-9-]*$/;
const GITHUB_REPO = 'airglow-inc/airglow-catalog';
const LOCKFILES = new Set(['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

type Source = { kind: 'dir'; dir: string } | { kind: 'github'; repo: string };

export class CatalogService {
  constructor(private workspace: string, private apps: AppServer) {}

  private appsDir() { return join(this.workspace, 'apps'); }
  private sidecarDir() { return join(this.workspace, 'state', 'catalog'); }
  private sidecarPath(appId: string) { return join(this.sidecarDir(), `${appId}.json`); }

  private resolveSource(): Source {
    const dir = process.env.AIRGLOW_CATALOG_DIR;
    if (dir) return { kind: 'dir', dir };
    // Dev (running from source, not a compiled binary): use the sibling repo.
    if (!Bun.main.includes('$bunfs')) {
      const sibling = join(import.meta.dir, '..', '..', '..', '..', 'airglow-catalog');
      if (existsSync(join(sibling, 'catalog.json'))) return { kind: 'dir', dir: sibling };
    }
    return { kind: 'github', repo: GITHUB_REPO };
  }

  // Stable content hash of an app dir (skips node_modules, .env, dotfiles).
  private hashApp(dir: string): string {
    const h = createHash('md5');
    const walk = (d: string) => {
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name === 'node_modules' || e.name === '.env' || e.name.startsWith('.')) continue;
        if (LOCKFILES.has(e.name)) continue; // install artifacts, not source
        const p = join(d, e.name);
        if (e.isDirectory()) { h.update('D:' + relative(dir, p) + '\n'); walk(p); }
        else { h.update('F:' + relative(dir, p) + '\n'); try { h.update(readFileSync(p)); } catch {} }
      }
    };
    walk(dir);
    return h.digest('hex').slice(0, 16);
  }

  // Resolve the app's source dir (a local checkout, or an extracted tarball).
  private async fetchAppDir(appId: string, src: Source): Promise<{ dir: string; cleanup?: string }> {
    if (src.kind === 'dir') {
      const appSrc = join(src.dir, appId);
      if (!existsSync(join(appSrc, 'manifest.json'))) throw new Error(`app '${appId}' not found in catalog`);
      return { dir: appSrc };
    }
    const tmp = join(this.workspace, 'state', `.catalog-tmp-${appId}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const res = await fetch(`https://codeload.github.com/${src.repo}/tar.gz/refs/heads/main`);
    if (!res.ok) throw new Error(`catalog fetch failed (HTTP ${res.status})`);
    const tgz = join(tmp, 'catalog.tgz');
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    const proc = Bun.spawnSync(['tar', '-xzf', tgz, '-C', tmp], { stderr: 'pipe' });
    if (proc.exitCode !== 0) throw new Error(`tar extract failed: ${proc.stderr.toString().slice(0, 300)}`);
    const root = readdirSync(tmp, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.includes('airglow-catalog'));
    if (!root) throw new Error('tarball missing repo root');
    const appSrc = join(tmp, root.name, appId);
    if (!existsSync(join(appSrc, 'manifest.json'))) throw new Error(`app '${appId}' not found in catalog`);
    return { dir: appSrc, cleanup: tmp };
  }

  async install(appId: string): Promise<{ ok: boolean; version?: string; error?: string }> {
    if (!APP_ID.test(appId)) return { ok: false, error: 'invalid app id' };
    try {
      const src = this.resolveSource();
      const { dir: appSrc, cleanup } = await this.fetchAppDir(appId, src);
      const target = join(this.appsDir(), appId);
      mkdirSync(this.appsDir(), { recursive: true });
      rmSync(target, { recursive: true, force: true });
      const cp = Bun.spawnSync(['cp', '-R', appSrc, target], { stderr: 'pipe' });
      if (cp.exitCode !== 0) throw new Error(`copy failed: ${cp.stderr.toString().slice(0, 300)}`);
      if (cleanup) rmSync(cleanup, { recursive: true, force: true });

      // Install the app's own dependencies into apps/<id>/node_modules. Per-app
      // (not workspace-root) so it works regardless of the workspace package
      // manager — the maintainer's checkout is pnpm, installed workspaces are
      // bun. Baseline deps (react, react-dom, tailwind, lucide-react) resolve
      // from the workspace root node_modules; apps declare only their extras.
      if (existsSync(join(target, 'package.json'))) {
        // --ignore-scripts: catalog apps are untrusted code. Bun already skips
        // dependency lifecycle scripts unless trustedDependencies opts them in;
        // this also blocks that opt-in and the app's own pre/postinstall, so a
        // malicious app or dep can't run arbitrary code at install time. App
        // server code still runs when the app is used — installing it does not.
        //
        // --frozen-lockfile (only when the app ships a bun.lock): install the
        // exact versions the maintainer reviewed and fail if package.json has
        // drifted from the lockfile, instead of silently re-resolving to newer
        // (possibly compromised) releases. Lockfile-less apps still install.
        const installArgs = existsSync(join(target, 'bun.lock'))
          ? ['install', '--frozen-lockfile', '--ignore-scripts']
          : ['install', '--ignore-scripts'];
        const install = Bun.spawnSync([process.execPath, ...installArgs], {
          cwd: target,
          env: { ...process.env, BUN_BE_BUN: '1' },
          stderr: 'pipe',
        });
        if (install.exitCode !== 0) {
          console.error(`[catalog/${appId}] bun install warned: ${install.stderr.toString().slice(0, 400)}`);
        }
        // The per-app install can materialise a real copy of a baseline dep
        // (react via a lucide-react peer, …) instead of hoisting to the root.
        // Two physical React copies → "Invalid hook call" at render — prune the
        // redundant same-version copies so resolution hoists to the one root copy.
        const pruned = dedupeAppDeps(target, this.workspace);
        if (pruned.length) console.log(`[catalog/${appId}] deduped ${pruned.length} shadowing dep copy(ies): ${pruned.join(', ')}`);
      }

      let version = '0.0.0';
      try { version = String(JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).version ?? '0.0.0'); } catch {}
      mkdirSync(this.sidecarDir(), { recursive: true });
      writeFileSync(this.sidecarPath(appId), JSON.stringify({
        appId, catalogVersion: version, installedSha: this.hashApp(target), installedAt: new Date().toISOString(),
      }, null, 2));

      await this.apps.scanManifests(); // pick up the new app immediately
      return { ok: true, version };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Uninstall: delete the app's workspace folder plus its daemon-owned
  // sidecars — catalog provenance (state/catalog/<id>.json) and UI-entered
  // secrets (state/secrets/<id>.env). Works for any installed app, catalog
  // or local. The APP_ID guard prevents path traversal.
  async uninstall(appId: string): Promise<{ ok: boolean; error?: string }> {
    if (!APP_ID.test(appId)) return { ok: false, error: 'invalid app id' };
    try {
      const target = join(this.appsDir(), appId);
      if (!existsSync(target)) return { ok: false, error: `app '${appId}' is not installed` };
      rmSync(target, { recursive: true, force: true });                                  // the app folder
      rmSync(this.sidecarPath(appId), { force: true });                                  // catalog provenance
      rmSync(join(this.workspace, 'state', 'secrets', `${appId}.env`), { force: true }); // UI-entered secrets
      await this.apps.scanManifests(); // drop it from the served list immediately
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Provenance for installed apps: which are from the catalog + locally modified.
  provenance(): Record<string, CatalogProvenance> {
    const out: Record<string, CatalogProvenance> = {};
    let files: string[] = [];
    try { files = readdirSync(this.sidecarDir()).filter((f) => f.endsWith('.json')); } catch { return out; }
    for (const f of files) {
      try {
        const meta = JSON.parse(readFileSync(join(this.sidecarDir(), f), 'utf8'));
        const appId: string = meta.appId ?? f.replace(/\.json$/, '');
        const target = join(this.appsDir(), appId);
        const modified = existsSync(target) ? this.hashApp(target) !== meta.installedSha : false;
        out[appId] = {
          appId,
          catalogVersion: String(meta.catalogVersion ?? '0.0.0'),
          installedAt: String(meta.installedAt ?? ''),
          modified,
        };
      } catch {}
    }
    return out;
  }
}
