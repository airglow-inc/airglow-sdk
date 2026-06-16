// Dedupe app-local dependency copies that merely shadow the workspace root.
//
// The workspace is a Bun workspace that hoists baseline deps (react, react-dom,
// tailwind, lucide-react) at its root. But a per-app `bun install` — the catalog
// installer, or an agent running `bun add` inside apps/<id> — materialises a
// REAL copy of a baseline dep into apps/<id>/node_modules when it's pulled in as
// a peer (e.g. react via lucide-react) instead of symlinking to the root store.
//
// Two physical copies of a stateful singleton in one UI bundle is a silent trap:
// the app's hooks bind the local React while react-dom binds the hoisted one →
// a null dispatcher → "Invalid hook call" at render, blank page, nothing logged.
// Removing the redundant copy lets resolution hoist to the single root copy.
//
// Conservative on purpose: only REAL (non-symlink) package dirs whose version
// EXACTLY matches the root copy are pruned. A different version is left alone —
// the app may genuinely want its own. node_modules is regenerable, so this only
// ever discards a byte-identical duplicate.

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function pkgVersion(dir: string): string | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// Top-level package names in a node_modules dir, expanding @scope/name.
function packageNames(nodeModules: string): string[] {
  const names: string[] = [];
  let entries: string[];
  try { entries = readdirSync(nodeModules); } catch { return names; }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // .bin, .cache, …
    if (entry.startsWith('@')) {
      try {
        for (const sub of readdirSync(join(nodeModules, entry))) names.push(`${entry}/${sub}`);
      } catch { /* ignore */ }
    } else {
      names.push(entry);
    }
  }
  return names;
}

// Prune one app's redundant copies. Returns the "name@version" of each removed.
export function dedupeAppDeps(appDir: string, workspace: string): string[] {
  const appNm = join(appDir, 'node_modules');
  const rootNm = join(workspace, 'node_modules');
  if (!existsSync(appNm) || !existsSync(rootNm)) return [];
  const pruned: string[] = [];
  for (const name of packageNames(appNm)) {
    const appPkg = join(appNm, name);
    let st;
    try { st = lstatSync(appPkg); } catch { continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) continue; // already linked → fine
    const rootPkg = join(rootNm, name);
    if (!existsSync(rootPkg)) continue; // app-only dep → keep
    const appVer = pkgVersion(appPkg);
    const rootVer = pkgVersion(rootPkg);
    if (!appVer || !rootVer || appVer !== rootVer) continue; // version differs → keep
    try {
      rmSync(appPkg, { recursive: true, force: true });
      pruned.push(`${name}@${appVer}`);
    } catch { /* ignore */ }
  }
  return pruned;
}

// Sweep every app under the workspace; logs a single summary line if anything
// was pruned. Cheap (a stat walk) and idempotent — safe to run on every boot.
export function dedupeWorkspaceApps(workspace: string): void {
  const appsDir = join(workspace, 'apps');
  if (!existsSync(appsDir)) return;
  const byApp: Record<string, string[]> = {};
  let total = 0;
  let apps: string[];
  try { apps = readdirSync(appsDir); } catch { return; }
  for (const app of apps) {
    if (app.startsWith('.')) continue;
    const appDir = join(appsDir, app);
    try { if (!lstatSync(appDir).isDirectory()) continue; } catch { continue; }
    const pruned = dedupeAppDeps(appDir, workspace);
    if (pruned.length) { byApp[app] = pruned; total += pruned.length; }
  }
  if (total > 0) {
    const detail = Object.entries(byApp).map(([a, p]) => `${a} (${p.join(', ')})`).join('; ');
    console.log(`deduped ${total} app-local dep copy(ies) shadowing the workspace root: ${detail}`);
  }
}
