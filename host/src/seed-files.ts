// Seed-tree collection from the repo checkout. Used by scripts/pack-seed.ts
// (which embeds the tree into the compiled binary as src/seed-assets.json)
// and by source-mode `airglow install` (which reads the repo directly).
//
// The tree maps workspace-relative paths to file contents. Sources:
//   host/seed/**             — the entire canonical seed surface: shared/ (theme/
//                              components), airglow.d.ts (SDK typings), docs/,
//                              AGENTS.md, CLAUDE.md, package.json, tsconfig.json.
//   extension/public/fonts/* — theme fonts → shared/fonts/

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SeedFile = { e: 'utf8' | 'b64'; c: string };
export type SeedTree = Record<string, SeedFile>;

const BINARY_EXT = /\.(woff2?|ttf|otf|png|jpe?g|webp|ico)$/i;
const SKIP = new Set(['node_modules', '.DS_Store']);

function addFile(tree: SeedTree, abs: string, rel: string): void {
  const buf = readFileSync(abs);
  tree[rel] = BINARY_EXT.test(rel)
    ? { e: 'b64', c: buf.toString('base64') }
    : { e: 'utf8', c: buf.toString('utf8') };
}

function addDir(tree: SeedTree, absDir: string, relBase: string): void {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const abs = join(absDir, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) addDir(tree, abs, rel);
    else addFile(tree, abs, rel);
  }
}

export function collectSeedFromRepo(hostDir: string): SeedTree {
  const tree: SeedTree = {};
  addDir(tree, join(hostDir, 'seed'), '');

  const fonts = join(hostDir, '..', 'extension', 'public', 'fonts');
  for (const f of [
    'inter-variable.woff2',
    'jetbrains-mono-variable.woff2',
    'LICENSE-Inter.txt',
    'LICENSE-JetBrainsMono.txt',
  ]) {
    addFile(tree, join(fonts, f), `shared/fonts/${f}`);
  }
  return tree;
}
