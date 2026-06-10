import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('cloud manifest and UI artifact reads require an Airglow identity session', async () => {
  const appLoader = await readFile(new URL('../lib/app-loader.ts', import.meta.url), 'utf8');
  const appShell = await readFile(new URL('../entrypoints/app-shell/main.ts', import.meta.url), 'utf8');

  assert.match(appLoader, /getAirglowIdentityHeaders\(\{\s*requireSession:\s*true\s*\}\)/);
  assert.match(appLoader, /cache:\s*source\.type\s*===\s*'cloud'\s*\?\s*'no-store'\s*:\s*'default'/);
  assert.match(appShell, /getAirglowIdentityHeaders\(\{\s*requireSession:\s*true\s*\}\)/);
});

test('sidepanel private save uses cloud identity, private endpoint, and reloads apps after save', async () => {
  const background = await readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
  const sidepanelModel = await readFile(new URL('../lib/sidepanel-model.ts', import.meta.url), 'utf8');
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');

  assert.match(background, /\/api\/apps\/private\/save/);
  assert.match(background, /getAirglowIdentityHeaders\(\{\s*requireSession:\s*true\s*\}\)/);
  assert.match(background, /refreshSavedAppRegistration\(cloud\.appId\)/);
  assert.match(background, /refreshSavedAppRegistration\(appId\)/);
  assert.match(background, /airglow:sidepanel:reload-target/);
  assert.match(background, /chrome\.tabs\.reload\(tabId\)/);
  assert.match(background, /appStorageKey\(appId,\s*SIDEPANEL_INITIAL_CONTEXT_KEY\)/);
  assert.match(sidepanel, /setSavedAppId\(response\.cloud\.appId\)/);
  assert.match(sidepanel, /Refresh page/);
  assert.match(sidepanelModel, /This Airglow Cloud server does not support private app save yet/);
});

test('sidepanel reads target context after the user asks for an app', async () => {
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');

  assert.match(sidepanel, /type GenerationPhase = 'idle' \| 'reading_context' \| 'generating' \| 'ready' \| 'error'/);
  assert.match(sidepanel, /setGenerationPhase\('reading_context'\)/);
  assert.match(sidepanel, /await readTargetContext\(\)/);
  assert.doesNotMatch(sidepanel, /useEffect\(\(\) => \{\s*refreshTarget\(\);\s*\}, \[\]\);/);
});

test('sidepanel treats local fallback as a local draft, not a saved app', async () => {
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');

  assert.match(sidepanel, /type SaveState = 'idle' \| 'saving' \| 'saved' \| 'local' \| 'error'/);
  assert.match(sidepanel, /setSaveState\('local'\)/);
  assert.match(sidepanel, /Draft saved locally/);
  assert.match(sidepanel, /saveState === 'error' \|\| saveState === 'local'/);
  assert.match(sidepanel, /draft\.persistence\?\.mode === 'cloud'/);
});

test('app UI sandbox reports successful bundle execution to app-shell', async () => {
  const appShell = await readFile(new URL('../entrypoints/app-shell/main.ts', import.meta.url), 'utf8');
  const sandbox = await readFile(new URL('../public/app-ui-sandbox.html', import.meta.url), 'utf8');

  assert.match(sandbox, /_airglow_ui_ready/);
  assert.match(appShell, /airglowAppUiReady/);
});

test('private app userscript world ids are sanitized consistently', async () => {
  const appLoader = await readFile(new URL('../lib/app-loader.ts', import.meta.url), 'utf8');
  const messageHandler = await readFile(new URL('../lib/airglow-message-handler.ts', import.meta.url), 'utf8');
  const worldId = await readFile(new URL('../lib/airglow-world-id.ts', import.meta.url), 'utf8');

  assert.match(appLoader, /airglowUserScriptWorldId\(manifest\.id\)/);
  assert.match(messageHandler, /airglowUserScriptWorldId\(appId\)/);
  assert.doesNotMatch(appLoader, /`airglow:\$\{manifest\.id\}`/);
  assert.doesNotMatch(messageHandler, /`airglow:\$\{appId\}`/);
  assert.match(worldId, /replace\(\/\[\^A-Za-z0-9_\]\/g,\s*'_'\)/);
});
