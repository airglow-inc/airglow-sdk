#!/usr/bin/env node
/**
 * Launch Chrome with the Airglow extension loaded and CDP enabled.
 *
 * Usage:
 *   node scripts/chrome.mjs [--extension <dir>] [--user-data-dir=<dir>] [--profile <1-5>] [--port <n>] [--color <name>] [--fresh] [--no-cdp] [--no-native-host]
 *
 * Defaults (all resolved against cwd, so the same script serves multiple
 * checkouts — run it from the extension dir, or pass --extension):
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
 *   --no-native-host Don't register the native-messaging host, and remove any
 *                    manifest a prior run left in this profile. The host shows
 *                    as "not connected" and no daemon spawns. Skips the
 *                    `airglow install` call entirely — so it also avoids the
 *                    workspace reseed and the all-browsers manifest writes that
 *                    install performs. Use when testing a clean install from
 *                    scratch, or the host-missing onboarding card.
 *   --ask-email      After load, clear the dev-seeded user email so the
 *                    email-required gate fires on the next app open. Use to
 *                    test the email-onboarding flow without a prod build.
 *                    Incompatible with --no-cdp.
 *
 * Theme + chrome.log also live under <cwd>/.airglow/.
 *
 * Loads the unpacked extension via CDP pipe (Extensions.loadUnpacked is only
 * available over pipe, not websocket). The websocket on port 9222 stays
 * available for normal debugging — both transports coexist.
 */
import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, createWriteStream, existsSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSION_DIR = resolve(__dirname, '..', '..', 'extension');
const WORKSPACE_DIR = resolve(process.cwd(), '.airglow');
const DEFAULT_USER_DATA_DIR = join(WORKSPACE_DIR, 'chrome-profile');
const FRESH_USER_DATA_DIR = join(WORKSPACE_DIR, 'chrome-profile-fresh');
// Numbered persistent profiles for running several dev browsers side by side.
// Kept under ~/.airglow (not the per-checkout .airglow) so they're shared across
// checkouts and survive repo cleanups.
const USERDIRS_ROOT = join(homedir(), '.airglow', '.userdirs');

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SYSTEM_DEFAULT_PROFILE = join(process.env.HOME || '', 'Library/Application Support/Google/Chrome/Default');
const PASSWORD_FILES = [
  'Login Data',
  'Login Data-journal',
  'Login Data For Account',
  'Login Data For Account-journal',
];

const args = process.argv.slice(2);
function flagValue(name) {
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  return undefined;
}
const extDirArg = flagValue('extension') ?? args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--extension');
const extDir = resolve(extDirArg || DEFAULT_EXTENSION_DIR);
const fresh = args.includes('--fresh');
const noCdp = args.includes('--no-cdp');
const noNativeHost = args.includes('--no-native-host') || args.includes('--no-nm');
// Numbered persistent profile (1-5). Each maps to ~/.airglow/.userdirs/dir<N>,
// letting several dev browsers run side by side without colliding on the
// single-writer profile lock.
const profileArg = flagValue('profile');
if (profileArg !== undefined && !/^[1-5]$/.test(profileArg)) {
  console.error(`--profile must be a number from 1 to 5 (got "${profileArg}").`);
  process.exit(1);
}
// CDP websocket port for debugging. Override to run a second browser alongside
// one already on the default port (the websocket is single-occupancy; the load
// pipe below is independent of it). `--port` is the short alias for `--cdp-port`.
// With --profile N and no explicit port, derive 9221+N so the five profiles get
// distinct ports automatically (profile 1 -> 9222, ... profile 5 -> 9226).
const cdpPort = Number(
  flagValue('port') ?? flagValue('cdp-port') ?? (profileArg ? 9221 + Number(profileArg) : 9222),
);
const askEmail = args.includes('--ask-email');
const noPasswords = args.includes('--no-passwords');

// Named toolbar themes for the dev browser. `--color <name>` rewrites the theme
// manifest with the chosen palette; without it the existing manifest is kept
// (or the default written on first run). Each entry tints the title bar + tab
// strip so the dev browser is visually distinct from your daily Chrome.
const THEMES = {
  sage:     { frame: [218, 232, 213], text: [50, 70, 50],   link: [80, 120, 80]  },
  orange:   { frame: [251, 222, 196], text: [120, 64, 24],  link: [205, 110, 40] },
  sky:      { frame: [205, 226, 245], text: [40, 65, 100],  link: [55, 110, 185] },
  lavender: { frame: [228, 220, 246], text: [72, 56, 104],  link: [122, 92, 196] },
  rose:     { frame: [248, 214, 224], text: [110, 48, 72],  link: [190, 78, 122] },
};
const DEFAULT_THEME = 'sage';
const colorArg = flagValue('color');
if (colorArg && !THEMES[colorArg]) {
  console.error(`Unknown --color "${colorArg}". Choose one of: ${Object.keys(THEMES).join(', ')}.`);
  process.exit(1);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Launch Chrome with the Airglow extension + CDP.
Usage: pnpm chrome [-- <flags>]   (prefix flags with \`--\`, e.g. \`pnpm chrome -- --profile 2\`)

  --profile <1-5>    Persistent profile ~/.airglow/.userdirs/dir<N>; port 9221+N. Run several at once.
  --port <n>         CDP debug port (default 9222). Alias --cdp-port.
  --color <name>     Tint the title bar: sage, orange, sky, lavender, rose (default sage).
  --extension <dir>  Unpacked extension to load (default <sdk>/extension).
  --user-data-dir=<dir>  Profile dir override (wins over --profile).
  --fresh            Separate profile, wiped before launch.
  --no-cdp           No CDP, extension not loaded. Use to sign in to Google.
  --no-native-host   Don't register the native host (host shows disconnected).
  --ask-email        Clear dev email so the email gate fires on next app open.
  --no-passwords     Don't seed saved passwords from your default Chrome profile.
  --help, -h         Show this message.`);
  process.exit(0);
}
const userDataDir = resolve(
  args.find(a => a.startsWith('--user-data-dir='))?.split('=')[1]
    || (profileArg ? join(USERDIRS_ROOT, `dir${profileArg}`)
        : fresh ? FRESH_USER_DATA_DIR : DEFAULT_USER_DATA_DIR)
);
// Theme extension dir is per-profile, so `--color` on one profile never bleeds
// into another and concurrent launches can't race on a shared manifest.
const THEME_DIR = join(userDataDir, 'dev-theme');

if (profileArg) console.log(`Profile ${profileArg}: ${userDataDir} (CDP :${cdpPort})`);

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

// Install the native-messaging manifest into the user-data-dir Chrome will
// use (Chrome reads NM hosts from <user-data-dir>/NativeMessagingHosts when
// --user-data-dir is set, NOT the system default location). The host owns the
// manifest format, so delegate to it. Prefer the host source in this checkout
// (symmetric with loading the extension from source, and the from-source dev
// workflow has no ~/.airglow/bin/airglow); fall back to an installed binary.
mkdirSync(userDataDir, { recursive: true });
if (noNativeHost) {
  // Skip registration entirely (no `airglow install`, so no workspace reseed
  // and no all-browsers manifest writes) and drop any manifest a prior run left
  // in this profile, so the extension shows "host not connected" and no daemon
  // is spawned. Chrome reads NM hosts only from <user-data-dir>/NativeMessagingHosts
  // when --user-data-dir is set, so removing it here is sufficient.
  const nmFile = join(userDataDir, 'NativeMessagingHosts', 'com.airglow.host.json');
  rmSync(nmFile, { force: true });
  console.log('--no-native-host: native messaging not registered — host will show as not connected.');
} else {
  const hostMain = resolve(__dirname, '..', '..', 'host', 'src', 'main.ts');
  const bunBin = [join(homedir(), '.bun', 'bin', 'bun')].find(existsSync) || 'bun';
  const installedBin = [
    join(homedir(), '.airglow', 'bin', 'airglow'),
    join(homedir(), '.airglow', 'state', 'bin', 'airglow'),
  ].find(existsSync);
  const nmInstall = existsSync(hostMain)
    ? [bunBin, ['run', hostMain, 'install', userDataDir]]
    : installedBin
      ? [installedBin, ['install', userDataDir]]
      : null;
  if (nmInstall) {
    try {
      execFileSync(nmInstall[0], nmInstall[1], { stdio: 'inherit' });
    } catch (e) {
      console.warn(`native-messaging install failed (${e?.message ?? e}) — host may not connect in this profile.`);
    }
  } else {
    console.warn('Could not install the native-messaging manifest: no host/ source and no ~/.airglow host binary found. Native messaging will not connect in this profile.');
  }
}

// Seed saved passwords from the system default Chrome profile so the dev
// profile carries over logins. Only the "Login Data*" SQLite files are
// touched — the rest of the dev profile is left intact. Decryption works
// because the "Chrome Safe Storage" Keychain entry is user-wide on macOS.
if (!noPasswords) {
  if (!existsSync(SYSTEM_DEFAULT_PROFILE)) {
    console.log(`Password seed skipped: ${SYSTEM_DEFAULT_PROFILE} not found.`);
  } else {
    const targetProfile = join(userDataDir, 'Default');
    mkdirSync(targetProfile, { recursive: true });
    let copied = 0;
    for (const f of PASSWORD_FILES) {
      const src = join(SYSTEM_DEFAULT_PROFILE, f);
      if (!existsSync(src)) continue;
      try {
        copyFileSync(src, join(targetProfile, f));
        copied++;
      } catch (err) {
        console.error(`Failed to copy "${f}": ${err.message} (quit the main Chrome and retry, or pass --no-passwords)`);
      }
    }
    if (copied > 0) console.log(`Seeded ${copied} password file(s) from default Chrome profile.`);
  }
}

// Generate a tiny theme extension to color the dev-Chrome chrome (frame, toolbar,
// tabs). Visually distinguishes the dev browser from your daily Chrome. Rewritten
// every launch from --color (or sage by default) — no cache, so each launch's
// color is explicit and the default profile stays sage.
mkdirSync(THEME_DIR, { recursive: true });
const themeManifestPath = join(THEME_DIR, 'manifest.json');
// Chrome reuses "Cached Theme.pak" when the manifest version is unchanged, so
// drop it to force a recompile when the color changed since last launch.
rmSync(join(THEME_DIR, 'Cached Theme.pak'), { force: true });
{
  const t = THEMES[colorArg || DEFAULT_THEME];
  writeFileSync(themeManifestPath, JSON.stringify({
    manifest_version: 3,
    name: 'Airglow Dev',
    version: '1.0',
    theme: {
      colors: {
        // Only color the title bar + tab strip. Toolbar (URL row) stays Chrome default.
        frame:                t.frame,
        tab_background_text:  t.text,
        tab_text:             t.text,
        // Force the toolbar icons + separators to neutral gray so they don't
        // inherit the frame color and bleed into the URL row.
        toolbar_button_icon:  [95,  99, 104],
        // Keep the new-tab page neutral so it doesn't inherit the frame color.
        ntp_background:       [255, 255, 255],
        ntp_text:             t.text,
        ntp_link:             t.link,
      },
    },
  }, null, 2));
  if (colorArg) console.log(`Toolbar theme: ${colorArg}`);
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
    // CDP websocket for debugging (default :9222; override via --cdp-port)
    `--remote-debugging-port=${cdpPort}`,
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
  if (askEmail) {
    console.log('\n--ask-email: after manually loading the extension, open its service worker DevTools (chrome://extensions → "Inspect views: service worker") and paste:');
    console.log("  chrome.storage.local.set({__airglow_skip_dev_seed: true}); chrome.storage.local.remove('__airglow_user_email');");
    console.log('Then reload the extension. The email gate will fire on the next app open.\n');
  }
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

function cdpSend(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, msg => {
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    });
    const out = { id, method, params };
    if (sessionId) out.sessionId = sessionId;
    pipeOut.write(JSON.stringify(out) + '\0');
  });
}

let loadedExtId = null;
try {
  const result = await cdpSend('Extensions.loadUnpacked', { path: extDir });
  loadedExtId = result.id;
  console.log(`Extension loaded: ${result.id}`);
} catch (err) {
  console.error(`Failed to load extension: ${err.message}`);
}

if (askEmail && loadedExtId) {
  try {
    // Find the extension's service worker target (poll briefly — it may not be
    // registered the instant Extensions.loadUnpacked resolves).
    let swTarget = null;
    for (let i = 0; i < 30 && !swTarget; i++) {
      const { targetInfos } = await cdpSend('Target.getTargets');
      swTarget = targetInfos.find(t => t.type === 'service_worker' && t.url.includes(loadedExtId));
      if (!swTarget) await new Promise(r => setTimeout(r, 100));
    }
    if (!swTarget) throw new Error('service worker target not found');
    const { sessionId } = await cdpSend('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    // Give the SW a moment to run its boot-time auto-seed before we clear it.
    // We also write __airglow_skip_dev_seed so future SW reboots don't re-seed.
    await new Promise(r => setTimeout(r, 300));
    await cdpSend('Runtime.evaluate', {
      expression: `(async () => {
        await chrome.storage.local.set({ __airglow_skip_dev_seed: true });
        await chrome.storage.local.remove('__airglow_user_email');
      })()`,
      awaitPromise: true,
    }, sessionId);
    console.log('Disabled dev-email auto-seed and cleared current email (--ask-email)');
  } catch (err) {
    console.error(`--ask-email: failed: ${err.message}`);
  }
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
