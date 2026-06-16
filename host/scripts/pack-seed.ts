// Packs the workspace seed tree into src/seed-assets.json so `bun build
// --compile` embeds it in the binary. Run before every build (the build
// scripts do). The output is generated — gitignored, never edited.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSeedFromRepo } from '../src/seed-files';

const hostDir = join(import.meta.dir, '..');
const tree = collectSeedFromRepo(hostDir);
const out = join(hostDir, 'src', 'seed-assets.json');
const json = JSON.stringify(tree);
writeFileSync(out, json);
console.log(`packed ${Object.keys(tree).length} seed files (${(json.length / 1024).toFixed(0)} KB) → ${out}`);
