#!/usr/bin/env node
// Installs the Chrome native messaging manifest for the Airglow native bridge.
// Idempotent: safe to run on every `airglow dev`.
// macOS only (which is what the SDK currently targets).
//
// Usable two ways:
//   1. CLI:    node install.mjs
//   2. Import: import { installNativeHost } from './install.mjs'; installNativeHost();

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Keep the native-messaging host id stable for installed extensions. User-facing
// docs and logs call this component the Airglow native bridge.
const HOST_NAME = 'com.airglow.spy';
const EXTENSION_ID = 'comikpjjijckpjkobpkkpnnhlcpmagic'; // derived from pinned manifest.key

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function installNativeHost({ quiet = false, extraDirs = [] } = {}) {
  if (process.platform !== 'darwin') {
    if (!quiet) console.error('[airglow] native host install: macOS only, skipping');
    return { installed: 0, skipped: true };
  }

  const hostScript = path.join(__dirname, 'host.mjs');
  const hostWrapper = path.join(__dirname, 'host.sh');

  for (const f of [hostScript, hostWrapper]) {
    try { fs.chmodSync(f, 0o755); }
    catch (e) { if (!quiet) console.error(`[airglow] chmod ${f} failed: ${e.message}`); }
  }

  const manifest = {
    name: HOST_NAME,
    description: 'Airglow extension native bridge (logs, reload)',
    path: hostWrapper,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };

  const manifestDirs = [
    path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
    path.join(os.homedir(), 'Library/Application Support/Chromium/NativeMessagingHosts'),
    ...extraDirs,
  ];

  let installed = 0;
  for (const dir of manifestDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${HOST_NAME}.json`);
      const next = JSON.stringify(manifest, null, 2);
      let current = null;
      try { current = fs.readFileSync(file, 'utf8'); } catch {}
      if (current !== next) {
        fs.writeFileSync(file, next);
        if (!quiet) console.log(`[airglow] installed native host manifest at ${file}`);
        installed++;
      }
    } catch (e) {
      if (!quiet) console.error(`[airglow] failed to install at ${dir}: ${e.message}`);
    }
  }
  return { installed, skipped: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installNativeHost();
}
