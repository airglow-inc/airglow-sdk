#!/usr/bin/env node
/**
 * Launch Chrome with the Airglow extension loaded and CDP enabled.
 *
 * Usage:
 *   node scripts/chrome.mjs [extension-dir] [--user-data-dir=<dir>] [--fresh] [--no-cdp]
 *
 * Defaults (all resolved against cwd, so the same script serves multiple
 * workspaces — e.g. airglow-apps and airglow/extension):
 *   extension-dir    <sdk>/extension (bundled SDK extension; absolute fallback)
 *   --user-data-dir  <cwd>/.airglow/chrome-profile (dedicated profile; the
 *                    native-messaging manifest is installed into
 *                    <user-data-dir>/NativeMessagingHosts/ so /logs and /reload
 *                    work in this profile).
 *   --fresh          Use <cwd>/.airglow/chrome-profile-fresh and wipe it before
 *                    launch. Useful for testing first-run / clean-state flows
 *                    (e.g. the "Allow User Scripts" toggle being off by default).
 *   --no-cdp         Launch Chrome with no CDP flags and no extension loading.
 *                    Use this to sign in to Google in the dev profile without
 *                    the "browser may not be secure" block; quit Chrome when
 *                    done and re-run `pnpm chrome` to resume with CDP.
 *
 * Theme + chrome.log also live under <cwd>/.airglow/.
 *
 * Loads the unpacked extension via CDP pipe (Extensions.loadUnpacked is only
 * available over pipe, not websocket). The websocket on port 9222 stays
 * available for normal debugging — both transports coexist.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, createWriteStream, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { installNativeHost } from '../../cli/lib/native-host/install.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSION_DIR = resolve(__dirname, '..', '..', 'extension');
const WORKSPACE_DIR = resolve(process.cwd(), '.airglow');
const DEFAULT_USER_DATA_DIR = join(WORKSPACE_DIR, 'chrome-profile');
const FRESH_USER_DATA_DIR = join(WORKSPACE_DIR, 'chrome-profile-fresh');
const THEME_DIR = join(WORKSPACE_DIR, 'dev-theme');

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const extDirArg = args.find(a => !a.startsWith('--'));
const extDir = resolve(extDirArg || DEFAULT_EXTENSION_DIR);
const fresh = args.includes('--fresh');
const noCdp = args.includes('--no-cdp');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: pnpm chrome[:fresh] [--no-cdp] [--user-data-dir=<dir>] [extension-dir]

Launches Chrome with the Airglow extension loaded and CDP enabled.

Flags:
  --fresh             Use a separate profile dir and wipe it before launch.
                      Seeds the new profile from the regular dev profile
                      (Preferences, History, …) minus auth/session files.
  --no-cdp            Launch without CDP flags and without loading the
                      extension. Use to sign in to Google in the dev profile
                      (Google blocks sign-in when CDP is on); quit Chrome
                      when done and re-run \`pnpm chrome\` to resume with CDP.
  --user-data-dir=<dir>  Override the profile directory.
  --help, -h          Show this message.

Profiles live under <cwd>/.airglow/:
  chrome-profile        regular (pnpm chrome)
  chrome-profile-fresh  wiped each --fresh run`);
  process.exit(0);
}
const userDataDir = resolve(
  args.find(a => a.startsWith('--user-data-dir='))?.split('=')[1]
    || (fresh ? FRESH_USER_DATA_DIR : DEFAULT_USER_DATA_DIR)
);

if (fresh) {
  console.log(`Wiping fresh profile: ${userDataDir}`);
  rmSync(userDataDir, { recursive: true, force: true });
}

if (!existsSync(extDir)) {
  console.error(`Extension directory not found: ${extDir}`);
  process.exit(1);
}

// Clean up leftover phantom-profile state from earlier experiments. If a stale
// `Profile 2` info_cache entry is still in Local State, Chrome will keep
// surfacing a profile picker. Strip it out and reset name overrides.
const localStatePath = join(userDataDir, 'Local State');
if (existsSync(localStatePath)) {
  try {
    const localState = JSON.parse(readFileSync(localStatePath, 'utf8'));
    const ic = localState.profile?.info_cache;
    if (ic && 'Profile 2' in ic) {
      delete ic['Profile 2'];
      if (localState.profile.profiles_order) {
        localState.profile.profiles_order = localState.profile.profiles_order.filter(p => p !== 'Profile 2');
      }
      writeFileSync(localStatePath, JSON.stringify(localState, null, 2));
    }
  } catch { /* ignore */ }
}

// Install native messaging manifest into the user-data-dir Chrome will use.
// Chrome reads NM hosts from <user-data-dir>/NativeMessagingHosts when --user-data-dir
// is set, NOT the system default location.
mkdirSync(userDataDir, { recursive: true });
installNativeHost({ extraDirs: [join(userDataDir, 'NativeMessagingHosts')] });

// Generate a tiny theme extension to color the dev-Chrome chrome (frame, toolbar,
// tabs). Visually distinguishes the dev browser from your daily Chrome. Only
// created if missing — edit .airglow/dev-theme/manifest.json to change colors.
mkdirSync(THEME_DIR, { recursive: true });
const themeManifestPath = join(THEME_DIR, 'manifest.json');
if (!existsSync(themeManifestPath)) {
  writeFileSync(themeManifestPath, JSON.stringify({
    manifest_version: 3,
    name: 'Airglow Dev',
    version: '1.0',
    theme: {
      colors: {
        // Only color the title bar + tab strip. Toolbar (URL row) stays Chrome default.
        // Pale sage — subtle "this is the dev browser" tint without shouting.
        frame:                [218, 232, 213],
        tab_background_text:  [70,   90,  70],
        tab_text:             [50,   70,  50],
        // Force the toolbar icons + separators to neutral gray so they don't
        // inherit the frame color and bleed into the URL row.
        toolbar_button_icon:  [95,  99, 104],
        // Keep the new-tab page neutral so it doesn't inherit the frame color.
        ntp_background:       [255, 255, 255],
        ntp_text:             [50,   70,  50],
        ntp_link:             [80,  120,  80],
      },
    },
  }, null, 2));
}

const chromeArgs = [
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-crash-restore-bubble',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-background-networking',
  '--disable-client-side-phishing-detection',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-component-extensions-with-background-pages',
  '--disable-domain-reliability',
  '--disable-hang-monitor',
  '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,PrivacySandboxSettings4,RenderDocument,IdentityStatusDialog,FedCm',
  '--noerrdialogs',
  '--suppress-message-center-popups',
];
if (!noCdp) {
  chromeArgs.push(
    // CDP websocket for debugging (always available on :9222)
    '--remote-debugging-port=9222',
    // CDP pipe for Extensions.loadUnpacked (only method that works on branded Chrome)
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
  );
}
chromeArgs.push(`--user-data-dir=${userDataDir}`);

const logDir = join(WORKSPACE_DIR, 'logs');
mkdirSync(logDir, { recursive: true });
const logStream = createWriteStream(resolve(logDir, 'chrome.log'));

const chrome = spawn(CHROME_BIN, chromeArgs, {
  stdio: noCdp
    ? ['ignore', 'pipe', 'pipe']
    : ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
});

chrome.stdout.on('data', d => { process.stdout.write(d); logStream.write(d); });
chrome.stderr.on('data', d => { process.stderr.write(d); logStream.write(d); });

if (noCdp) {
  console.log('Launched Chrome without CDP. Extension not loaded.');
  console.log('Use this profile to sign in to Google, then quit Chrome and re-run `pnpm chrome`.');
  chrome.on('exit', code => process.exit(code ?? 0));
  process.on('SIGINT', () => chrome.kill());
  process.on('SIGTERM', () => chrome.kill());
  // Nothing else to do — skip the CDP-pipe wiring below.
  await new Promise(() => {});
}

const pipeOut = chrome.stdio[3];
const pipeIn = chrome.stdio[4];
let msgId = 0;
const pending = new Map();
let received = '';

pipeIn.on('data', chunk => {
  received += chunk;
  let end = received.indexOf('\0');
  while (end !== -1) {
    const raw = received.slice(0, end);
    received = received.slice(end + 1);
    const msg = JSON.parse(raw);
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
    end = received.indexOf('\0');
  }
});

function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, msg => {
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    });
    pipeOut.write(JSON.stringify({ id, method, params }) + '\0');
  });
}

try {
  const result = await cdpSend('Extensions.loadUnpacked', { path: extDir });
  console.log(`Extension loaded: ${result.id}`);
} catch (err) {
  console.error(`Failed to load extension: ${err.message}`);
}

try {
  const theme = await cdpSend('Extensions.loadUnpacked', { path: THEME_DIR });
  console.log(`Theme loaded: ${theme.id}`);
} catch (err) {
  console.error(`Failed to load theme: ${err.message}`);
}

chrome.on('exit', code => process.exit(code ?? 0));

let closing = false;
async function gracefulShutdown() {
  if (closing) return;
  closing = true;
  console.log('\nClosing Chrome gracefully...');
  try { await cdpSend('Browser.close'); }
  catch { chrome.kill(); }
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
