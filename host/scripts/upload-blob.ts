// Uploads gzipped host binaries + a manifest to the public Vercel Blob store
// (airglow-host). install.sh pulls these via the api.airglow.dev/host/<asset>
// redirect. Run after build-release.sh.
//
//   BLOB_READ_WRITE_TOKEN=… bun run scripts/upload-blob.ts [version]
//
// Each binary is uploaded to two stable pathnames:
//   host/<version>/airglow-<t>.gz  — immutable archive (long CDN cache)
//   host/latest/airglow-<t>.gz     — what the installer resolves (short cache)
import { put } from '@vercel/blob';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error('upload-blob: BLOB_READ_WRITE_TOKEN is required');
  process.exit(1);
}

const version = process.argv[2] || pkg.version;
const targets = ['darwin-arm64', 'darwin-x64', 'linux-x64'] as const;

const YEAR = 31536000;
const FIVE_MIN = 300;

const assets: Record<string, { file: string; sha256: string }> = {};

for (const t of targets) {
  const gz = readFileSync(new URL(`../dist/airglow-${t}.gz`, import.meta.url));
  const raw = readFileSync(new URL(`../dist/airglow-${t}`, import.meta.url));
  const sha256 = createHash('sha256').update(raw).digest('hex');
  assets[t] = { file: `airglow-${t}.gz`, sha256 };

  // Immutable archive copy (long cache).
  const archived = await put(`host/${version}/airglow-${t}.gz`, gz, {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/gzip', cacheControlMaxAge: YEAR, token,
  });
  // Rolling "latest" the installer resolves (short cache so releases propagate).
  const latest = await put(`host/latest/airglow-${t}.gz`, gz, {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/gzip', cacheControlMaxAge: FIVE_MIN, token,
  });
  console.log(`uploaded ${t}: ${(gz.length / 1048576).toFixed(1)} MB`);
  console.log(`  archive: ${archived.url}`);
  console.log(`  latest:  ${latest.url}`);
}

const manifest = JSON.stringify({ version, assets }, null, 2);
await put('host/latest/manifest.json', manifest, {
  access: 'public', addRandomSuffix: false, allowOverwrite: true,
  contentType: 'application/json', cacheControlMaxAge: FIVE_MIN, token,
});
await put(`host/${version}/manifest.json`, manifest, {
  access: 'public', addRandomSuffix: false, allowOverwrite: true,
  contentType: 'application/json', cacheControlMaxAge: YEAR, token,
});
console.log(`uploaded manifest (v${version})`);
