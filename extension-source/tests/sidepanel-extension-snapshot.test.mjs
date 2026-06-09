import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function readJson(url) {
  return JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
}

test('committed extension snapshot exposes the Airglow side panel', async () => {
  const manifest = await readJson(new URL('../../extension/manifest.json', import.meta.url));
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.ok(manifest.permissions.includes('sidePanel'));
  const edgeButtonEntries = (manifest.content_scripts || [])
    .filter((entry) => (entry.js || []).includes('content-scripts/edge-button.js'));
  assert.equal(edgeButtonEntries.length, 1);

  const sidepanelHtml = await readFile(fileURLToPath(new URL('../../extension/sidepanel.html', import.meta.url)), 'utf8');
  assert.match(sidepanelHtml, /chunks\/sidepanel-/);
  assert.match(sidepanelHtml, /assets\/sidepanel-/);
});
