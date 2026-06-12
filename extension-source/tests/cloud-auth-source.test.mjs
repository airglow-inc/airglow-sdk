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
  assert.match(sidepanel, /Reviewing app\.\.\./);
  assert.match(sidepanel, /Repairing if needed\.\.\./);
  assert.match(sidepanel, /Browser smoke\.\.\./);
  assert.match(sidepanel, /static_review:\s*4/);
  assert.match(sidepanel, /repairing:\s*5/);
  assert.match(sidepanel, /browser_smoke:\s*6/);
  assert.match(sidepanelModel, /applyGenerationRunEventsToDraft/);
  assert.match(sidepanelModel, /\|\s*'static_review'/);
  assert.match(sidepanelModel, /\|\s*'repairing'/);
  assert.match(sidepanelModel, /\|\s*'browser_smoke'/);
  assert.match(sidepanelModel, /This Airglow Cloud server does not support private app save yet/);
});

test('extension requires real account sign-in for Airglow identity', async () => {
  const identity = await readFile(new URL('../lib/airglow-identity.ts', import.meta.url), 'utf8');
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');
  const dashboard = await readFile(new URL('../entrypoints/dashboard/App.tsx', import.meta.url), 'utf8');
  const appShell = await readFile(new URL('../entrypoints/app-shell/main.ts', import.meta.url), 'utf8');

  assert.match(identity, /signInAirglowWithGoogle/);
  assert.match(identity, /createClient/);
  assert.match(identity, /signInWithOAuth/);
  assert.match(identity, /exchangeCodeForSession/);
  assert.match(identity, /chrome\.identity\.launchWebAuthFlow/);
  assert.match(identity, /provider:\s*'google'/);
  assert.match(identity, /signInAirglowWithPassword/);
  assert.match(identity, /createAirglowAccountWithPassword/);
  assert.match(identity, /signInWithPassword/);
  assert.match(identity, /signUp/);
  assert.match(identity, /provider:\s*'email'/);
  assert.match(identity, /getAirglowAuthProviderConfig/);
  assert.match(identity, /emailPasswordEnabled/);
  assert.match(identity, /Sign in to Airglow to continue/);
  assert.doesNotMatch(identity, /provider:\s*'airglow'/);
  assert.match(identity, /\/api\/identity\/session/);
  assert.match(sidepanel, /Sign in to Airglow/);
  assert.match(sidepanel, /Airglow apps, page injection, and cloud generation require an account/);
  assert.match(sidepanel, /signInAirglowWithPassword/);
  assert.match(sidepanel, /createAirglowAccountWithPassword/);
  assert.match(sidepanel, /signInAirglowWithGoogle/);
  assert.match(sidepanel, /getAirglowAuthProviderConfig/);
  assert.match(sidepanel, /authProviderConfig\.googleOAuthEnabled/);
  assert.match(sidepanel, /authProviderConfig\.emailPasswordEnabled/);
  assert.match(sidepanel, /signOutAirglowIdentity/);
  assert.match(sidepanel, /authState\.authenticated && chatInput\.trim\(\)\.length > 0/);
  assert.doesNotMatch(sidepanel, /Sign out of Airglow on this browser/);
  assert.match(appShell, /bootAppShell/);
  assert.match(appShell, /getAirglowIdentityHeaders\(\{\s*requireSession:\s*true\s*\}\)/);
  assert.match(appShell, /renderAuthRequiredMessage/);
  assert.match(appShell, /Airglow apps, page injection, and cloud generation are unavailable until this browser is signed in/);
  assert.match(appShell, /Open dashboard/);
  assert.match(dashboard, /sign-in-airglow-button/);
  assert.match(dashboard, /sign-in-google-button/);
  assert.match(dashboard, /getAirglowAuthProviderConfig/);
  assert.match(dashboard, /authProviderConfig\.googleOAuthEnabled/);
  assert.match(dashboard, /authProviderConfig\.emailPasswordEnabled/);
  assert.match(dashboard, /signInAirglowWithPassword/);
  assert.match(dashboard, /createAirglowAccountWithPassword/);
  assert.match(dashboard, /signInAirglowWithGoogle/);
  assert.match(dashboard, /signOutAirglowIdentity/);
  assert.doesNotMatch(dashboard, /Sign out of Airglow on this browser/);
  assert.doesNotMatch(dashboard, /Identity<\/span>\s*email/);
  assert.doesNotMatch(dashboard, /saveUserEmail/);
  assert.doesNotMatch(dashboard, /user-email-input/);
});

test('background clears runtime apps when the extension is signed out', async () => {
  const background = await readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');

  assert.match(background, /getVerifiedAirglowAuthState/);
  assert.match(background, /clearRuntimeAppsForSignedOutUser/);
  assert.match(background, /\[APP_MANIFESTS_KEY\]: \[\]/);
  assert.match(background, /chrome\.userScripts\.unregister\(\)/);
  assert.match(background, /AIRGLOW_AUTH_PROVIDER_KEY in changes/);
  assert.match(background, /AIRGLOW_SESSION_TOKEN_KEY in changes/);
});

test('page edge button is hidden until the browser is signed in', async () => {
  const contentScript = await readFile(new URL('../entrypoints/edge-button.content.ts', import.meta.url), 'utf8');
  const edgeButton = await readFile(new URL('../lib/edge-button.ts', import.meta.url), 'utf8');

  assert.match(contentScript, /browserIsSignedInToAirglow/);
  assert.match(contentScript, /__airglow_session_token/);
  assert.match(contentScript, /__airglow_auth_provider/);
  assert.match(contentScript, /provider === 'email' \|\| provider === 'google'/);
  assert.match(contentScript, /if \(signedIn\) createEdgeButton\(\)/);
  assert.match(contentScript, /else removeEdgeButtonSurfaces\(\)/);
  assert.match(contentScript, /chrome\.storage\.local\.onChanged\.addListener/);
  assert.match(edgeButton, /export function removeEdgeButtonSurfaces/);
  assert.match(edgeButton, /\[data-airglow-edge-button-root="true"\], \[data-testid="airglow-edge-popup"\]/);
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
  const sidepanelModel = await readFile(new URL('../lib/sidepanel-model.ts', import.meta.url), 'utf8');

  assert.match(sidepanel, /type GenerationPhase = 'idle' \| 'reading_context' \| 'generating' \| 'ready' \| 'error'/);
  assert.match(sidepanel, /setGenerationPhase\('reading_context'\)/);
  assert.match(sidepanel, /await readTargetContext\(\)/);
  assert.match(sidepanel, /draftRequestsCurrentPage\(draftForChat\)/);
  assert.match(sidepanelModel, /function promptRequestsCurrentPage/);
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

test('sidepanel lists apps and can refine private cloud apps', async () => {
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');
  const sidepanelModel = await readFile(new URL('../lib/sidepanel-model.ts', import.meta.url), 'utf8');

  assert.match(sidepanel, /type:\s*'airglow:get-dashboard-manifests'/);
  assert.match(sidepanel, /type SidePanelView = 'build' \| 'apps'/);
  assert.match(sidepanel, /function AppsTab/);
  assert.match(sidepanel, /function RailButton/);
  assert.match(sidepanel, /label="Apps"/);
  assert.match(sidepanel, /active=\{signedIn && activeView === 'apps'\}/);
  assert.match(sidepanel, /disabled=\{!signedIn\}/);
  assert.match(sidepanel, /Refine/);
  assert.match(sidepanel, /Open/);
  assert.match(sidepanel, /function startRefineApp\(app: SourcedManifest\)/);
  assert.match(sidepanel, /previousAppCloudMetadataForManifest\(app\)/);
  assert.match(sidepanel, /setSavedAppId\(app\.id\)/);
  assert.match(sidepanel, /setActiveView\('build'\)/);
  assert.match(sidepanelModel, /previousAppForPayload/);
});

test('sidepanel exposes dashboard as a top-level tab action', async () => {
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');
  const style = await readFile(new URL('../entrypoints/sidepanel/style.css', import.meta.url), 'utf8');

  assert.match(sidepanel, /<nav className="sidepanel-rail"/);
  assert.match(sidepanel, /<LayoutDashboard size=\{20\} \/>/);
  assert.match(sidepanel, /Dashboard/);
  assert.match(sidepanel, /type:\s*'airglow:open-dashboard'/);
  assert.match(style, /\.sidepanel\s*\{[\s\S]*flex-direction:\s*row/);
  assert.match(style, /\.sidepanel-rail\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(style, /\.sidepanel-rail\s*\{[\s\S]*order:\s*2/);
  assert.match(style, /\.sidepanel-content\s*\{[\s\S]*order:\s*1/);
  assert.match(style, /\.sidepanel-rail\s*\{[\s\S]*border-top-left-radius:\s*0/);
  assert.match(style, /\.sidepanel-rail\s*\{[\s\S]*border-bottom-left-radius:\s*0/);
  const actionsBlock = sidepanel.slice(
    sidepanel.indexOf('actions-message'),
    sidepanel.indexOf('<form className="chat-composer"'),
  );
  assert.doesNotMatch(actionsBlock, /openDashboard|Open dashboard/);
});

test('sidepanel has an explicit new app action that clears the active draft', async () => {
  const background = await readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');

  assert.match(sidepanel, /function startNewApp\(\)/);
  assert.match(sidepanel, /Discard current draft and start a new app\?/);
  assert.match(sidepanel, /ariaLabel="New app"/);
  assert.match(sidepanel, /tooltip="Start a new app"/);
  assert.match(sidepanel, /type:\s*'airglow:sidepanel:clear-last-draft'/);
  assert.match(background, /msg\?\.type === 'airglow:sidepanel:clear-last-draft'/);
  assert.match(background, /chrome\.storage\.local\.remove\(SIDEPANEL_LAST_DRAFT_KEY\)/);
});

test('sidepanel composer uses chat-like keyboard and empty states', async () => {
  const sidepanel = await readFile(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');
  const style = await readFile(new URL('../entrypoints/sidepanel/style.css', import.meta.url), 'utf8');

  assert.match(sidepanel, /function handleComposerKeyDown/);
  assert.match(sidepanel, /event\.key !== 'Enter' \|\| event\.shiftKey \|\| event\.nativeEvent\.isComposing/);
  assert.match(sidepanel, /event\.currentTarget\.form\?\.requestSubmit\(\)/);
  assert.match(sidepanel, /onKeyDown=\{handleComposerKeyDown\}/);
  assert.match(style, /\.chat-log\.empty\s*\{[\s\S]*align-content:\s*end/);
  assert.match(style, /\.send-button:disabled\s*\{[\s\S]*background:\s*var\(--disabled-bg\)/);
  assert.doesNotMatch(sidepanel, /welcome-screen|welcome-mark/);
});

test('background polls cloud browser tool calls through extension identity', async () => {
  const background = await readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');

  assert.match(background, /BROWSER_TOOL_BRIDGE_ALARM/);
  assert.match(background, /\/api\/browser-tools\/calls\/claim/);
  assert.match(background, /\/api\/browser-tools\/calls\/\$\{encodeURIComponent\(callId\)\}\/result/);
  assert.match(background, /getAirglowIdentityHeaders\(\{\s*requireSession:\s*true\s*\}\)/);
  assert.match(background, /executeBrowserCurrentTabTool/);
  assert.match(background, /executeBrowserReadPageTool/);
  assert.match(background, /executeBrowserInspectDomTool/);
  assert.match(background, /executeBrowserWaitForTextTool/);
  assert.match(background, /executeBrowserClickTool/);
  assert.match(background, /executeBrowserTypeTextTool/);
  assert.match(background, /executeBrowserListTabsTool/);
  assert.match(background, /executeBrowserOpenTabTool/);
  assert.match(background, /executeBrowserActivateTabTool/);
  assert.match(background, /executeBrowserNavigateTabTool/);
  assert.match(background, /executeBrowserReloadTabTool/);
  assert.match(background, /browser\.smoke_generated_app/);
  assert.match(background, /executeBrowserSmokeGeneratedAppTool/);
  assert.match(background, /observedTexts/);
  assert.match(background, /runtimeErrors/);
  assert.match(background, /consoleErrors/);
  assert.match(background, /consoleWarnings/);
  assert.match(background, /unhandledrejection/);
  assert.match(background, /requestBrowserToolUserApproval/);
  assert.match(background, /window\.confirm\(text\)/);
  assert.match(background, /chrome\.tabs\.create/);
  assert.match(background, /chrome\.tabs\.update/);
  assert.match(background, /chrome\.tabs\.reload/);
  assert.match(background, /chrome\.scripting\.executeScript/);
  const passiveReadSource = background.slice(
    background.indexOf('async function executeBrowserReadPageTool'),
    background.indexOf('function browserToolString'),
  );
  assert.doesNotMatch(passiveReadSource, /chrome\.tabs\.update/);
  assert.doesNotMatch(passiveReadSource, /chrome\.tabs\.create/);
  assert.doesNotMatch(passiveReadSource, /chrome\.tabs\.reload/);
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
