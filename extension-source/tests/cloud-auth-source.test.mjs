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

test('sidepanel private generation uses cloud identity, private endpoints, and reloads apps after save', async () => {
  const background = await readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
  const sidepanelModel = await readFile(new URL('../lib/sidepanel-model.ts', import.meta.url), 'utf8');
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');

  assert.match(background, /\/api\/apps\/private\/save/);
  assert.match(background, /\/api\/apps\/private\/generation-runs/);
  assert.match(background, /\/api\/apps\/private\/generation-runs\/\$\{encodeURIComponent\(runId\)\}\/execute/);
  assert.match(background, /msg\?\.type\s*===\s*'airglow:sidepanel:create-generation-run'/);
  assert.match(background, /msg\?\.type\s*===\s*'airglow:sidepanel:get-generation-run'/);
  assert.match(background, /msg\?\.type\s*===\s*'airglow:sidepanel:execute-generation-run'/);
  assert.match(background, /getAirglowIdentityHeaders\(\{\s*requireSession:\s*true\s*\}\)/);
  assert.match(background, /refreshSavedAppRegistration\(cloud\.appId\)/);
  assert.match(background, /refreshSavedAppRegistration\(appId\)/);
  assert.match(background, /airglow:sidepanel:reload-target/);
  assert.match(background, /chrome\.tabs\.reload\(tabId\)/);
  assert.match(background, /appStorageKey\(appId,\s*SIDEPANEL_INITIAL_CONTEXT_KEY\)/);
  assert.match(sidepanel, /setSavedAppId\(executed\.cloud\.appId\)/);
  assert.match(sidepanel, /type:\s*'airglow:sidepanel:create-generation-run'/);
  assert.match(sidepanel, /type:\s*'airglow:sidepanel:get-generation-run'/);
  assert.match(sidepanel, /type:\s*'airglow:sidepanel:execute-generation-run'/);
  assert.match(sidepanel, /Refresh page/);
  assert.match(sidepanelModel, /applyGenerationRunEventsToDraft/);
  assert.match(sidepanelModel, /This Airglow Cloud server does not support private app save yet/);
});

test('dashboard can edit and delete owner-scoped private apps through background', async () => {
  const background = await readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
  const dashboard = await readFile(new URL('../entrypoints/dashboard/App.tsx', import.meta.url), 'utf8');

  assert.match(background, /msg\?\.type\s*===\s*'airglow:private-app:update'/);
  assert.match(background, /msg\?\.type\s*===\s*'airglow:private-app:delete'/);
  assert.match(background, /requestPrivateAppMutation<[^>]+>\(appId,\s*'PATCH',\s*payload\)/);
  assert.match(background, /requestPrivateAppMutation<[^>]+>\(appId,\s*'DELETE'\)/);
  assert.match(background, /\/api\/apps\/private\/\$\{encodeURIComponent\(appId\)\}/);
  assert.match(background, /getAirglowIdentityHeaders\(\{\s*requireSession:\s*true\s*\}\)/);
  assert.match(background, /unregisterAppUserscripts\(appId\)/);
  assert.match(background, /removeDeletedPrivateAppLocalState\(appId\)/);
  assert.match(background, /loadAndRegisterApps\(true,\s*true\)/);

  assert.match(dashboard, /private-app-edit-modal/);
  assert.match(dashboard, /private-app-edit-name/);
  assert.match(dashboard, /private-app-edit-description/);
  assert.match(dashboard, /private-app-edit-summary/);
  assert.match(dashboard, /private-app-edit-tags/);
  assert.match(dashboard, /type:\s*'airglow:private-app:update'/);
  assert.match(dashboard, /type:\s*'airglow:private-app:delete'/);
  assert.match(dashboard, /window\.confirm\(`Delete "\$\{app\.name\}" from My Apps\?/);
});

test('sidepanel reads target context after the user asks for an app', async () => {
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');

  assert.match(sidepanel, /type GenerationPhase = 'idle' \| 'reading_context' \| 'generating' \| 'ready' \| 'error'/);
  assert.match(sidepanel, /setGenerationPhase\('reading_context'\)/);
  assert.match(sidepanel, /await readTargetContext\(\)/);
  assert.doesNotMatch(sidepanel, /useEffect\(\(\) => \{\s*refreshTarget\(\);\s*\}, \[\]\);/);
});

test('sidepanel treats generation failures as unsaved app errors', async () => {
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');

  assert.match(sidepanel, /type SaveState = 'idle' \| 'saving' \| 'saved' \| 'local' \| 'error'/);
  assert.match(sidepanel, /executed\.mode === 'failed'/);
  assert.match(sidepanel, /setSaveState\('error'\)/);
  assert.match(sidepanel, /Draft saved locally/);
  assert.match(sidepanel, /saveState === 'error' \|\| saveState === 'local'/);
  assert.match(sidepanel, /draft\.persistence\?\.mode === 'cloud'/);
});

test('app enable toggles update optimistically while registration sync remains authoritative', async () => {
  const appLoader = await readFile(new URL('../lib/app-loader.ts', import.meta.url), 'utf8');
  const background = await readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
  const dashboard = await readFile(new URL('../entrypoints/dashboard/App.tsx', import.meta.url), 'utf8');
  const edgeButton = await readFile(new URL('../lib/edge-button.ts', import.meta.url), 'utf8');

  assert.match(edgeButton, /const nextDisabled = !app\.disabled/);
  assert.match(edgeButton, /applyDisabledState\(nextDisabled\)/);
  assert.match(edgeButton, /if \(requestId !== toggleRequestId\) return/);
  assert.match(edgeButton, /app\.disabled = previousDisabled/);
  assert.match(edgeButton, /type: 'airglow:toggle-app', appId: app\.id, disabled: nextDisabled/);
  assert.match(dashboard, /const toggleRequestIds = useRef<Record<string, number>>\(\{\}\)/);
  assert.match(dashboard, /type: 'airglow:toggle-app', appId, disabled: nextDisabled/);
  assert.match(dashboard, /chrome\.runtime\.lastError \|\| res\?\.error/);
  assert.match(background, /const nowDisabled = typeof msg\.disabled === 'boolean' \? msg\.disabled : !wasDisabled/);
  assert.match(background, /function queueAppToggleRegistrationSync\(appId: string\): Promise<void>/);
  assert.match(background, /await queueAppToggleRegistrationSync\(appId\);\s*sendResponse\(\{ ok: true, disabled: nowDisabled \}\);/);
  assert.match(background, /await loadAndRegisterApps\(false, true\)/);
  assert.match(background, /const registrationAppIds = force \? undefined : Array\.from\(new Set\(\[\.\.\.changedApps, \.\.\.removedIds\]\)\)/);
  assert.match(background, /chrome\.storage\.local\.get\(APP_MANIFESTS_KEY\)/);
  assert.match(appLoader, /export const APP_MANIFESTS_KEY = '__app_manifests'/);
  assert.match(appLoader, /const targetAppIds = changedAppIds \? new Set\(changedAppIds\) : undefined/);
  assert.match(appLoader, /chrome\.userScripts\.getScripts\(\)/);
  assert.match(appLoader, /const manifestsToRegister = targetAppIds/);
  assert.match(edgeButton, /const APP_LIST_CACHE_TTL_MS = 15000/);
  assert.match(edgeButton, /function renderCachedApps\(key: string\)/);
  assert.match(edgeButton, /if \(res\.apps\.length === 0\) \{\s*if \(renderCachedApps\(key\)\) return/);

  const visualIndex = edgeButton.indexOf('applyDisabledState(nextDisabled);');
  const sendIndex = edgeButton.indexOf("chrome.runtime.sendMessage({ type: 'airglow:toggle-app'");
  assert.ok(visualIndex > 0, 'edge toggle should update visually');
  assert.ok(sendIndex > visualIndex, 'edge toggle should update before waiting on background');
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
