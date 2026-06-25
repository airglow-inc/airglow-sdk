// `airglow install` — registers this binary as the Chrome native messaging
// host (com.airglow.host) for every Chromium variant present on the machine,
// and prepares the workspace state dirs. Idempotent. This is the core the
// curl|bash installer wraps.
//
// Compiled binary: the NM manifest points at the binary directly. Source run
// (development): a launcher script with the absolute bun path baked in is
// generated, since Chrome inherits a sparse PATH from launchd/the desktop
// session and can't resolve `bun` itself.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { AIRGLOW_HOME, STATE_DIR, ensureStateDirs } from './paths';
import { seedWorkspace } from './seed';
import { EXTENSION_IDS } from './extension-ids';

const HOST_NAME = 'com.airglow.host';

// Per-platform NM directories per Chromium variant. The fork name is just a
// label for logging; what matters is the parent existing (= browser installed).
function manifestDirs(): { name: string; dir: string }[] {
  const home = homedir();
  if (process.platform === 'darwin') {
    const base = join(home, 'Library/Application Support');
    return ([
      ['Chrome', `${base}/Google/Chrome`],
      ['Chromium', `${base}/Chromium`],
      ['Brave', `${base}/BraveSoftware/Brave-Browser`],
      ['Edge', `${base}/Microsoft Edge`],
      ['Vivaldi', `${base}/Vivaldi`],
      ['Opera', `${base}/com.operasoftware.Opera`],
      ['Yandex', `${base}/Yandex/YandexBrowser`],
      ['Arc', `${base}/Arc/User Data`],
    ] as const).map(([name, parent]) => ({ name, dir: join(parent, 'NativeMessagingHosts') }));
  }
  if (process.platform === 'linux') {
    const base = join(home, '.config');
    return ([
      ['Chrome', `${base}/google-chrome`],
      ['Chromium', `${base}/chromium`],
      ['Brave', `${base}/BraveSoftware/Brave-Browser`],
      ['Edge', `${base}/microsoft-edge`],
      ['Vivaldi', `${base}/vivaldi`],
      ['Opera', `${base}/opera`],
      ['Yandex', `${base}/yandex-browser`],
    ] as const).map(([name, parent]) => ({ name, dir: join(parent, 'NativeMessagingHosts') }));
  }
  return [];
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function writeShim(path: string, body: string): void {
  let current: string | null = null;
  try { current = readFileSync(path, 'utf8'); } catch {}
  if (current !== body) writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Make `airglow` AND `bun` invocable from agent bash shells. Compiled binary
// named `airglow`: use its own dir (and drop a `bun` shim next to it).
// Otherwise (source run, or oddly-named binary): write both shims into
// state/bin and return that dir for PATH injection.
//
// The `bun` shim is load-bearing on end-user machines, which have no bun
// install: the system prompt and AGENTS.md tell agents `cd apps/<id> && bun
// add <pkg>`. BUN_BE_BUN=1 makes a compiled Bun executable behave as the
// plain bun CLI (no-op when execPath is a real bun, as in source runs).
export function ensureAirglowOnPath(): string {
  const isCompiled = Bun.main.includes('$bunfs');
  let binDir: string;
  if (isCompiled && basename(process.execPath) === 'airglow') {
    binDir = dirname(process.execPath);
  } else {
    binDir = join(STATE_DIR, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeShim(join(binDir, 'airglow'), isCompiled
      ? `#!/bin/bash\nexec ${shellQuote(process.execPath)} "$@"\n`
      : `#!/bin/bash\nexec ${shellQuote(process.execPath)} run ${shellQuote(Bun.main)} "$@"\n`);
  }
  try {
    writeShim(join(binDir, 'bun'), `#!/bin/bash\nBUN_BE_BUN=1 exec ${shellQuote(process.execPath)} "$@"\n`);
  } catch (e: any) {
    console.error(`could not write bun shim in ${binDir}: ${e?.message ?? e}`);
  }
  return binDir;
}

// Put the bin dir on the user's *interactive* PATH so coding agents they run
// in the workspace (Claude Code, Codex — terminal or desktop app) inherit it
// and never need a per-command `export PATH`. This is distinct from the
// daemon's own agent, which injects the bin dir into its bash PATH directly
// (daemon/index.ts → tools.ts); external agents only get whatever their
// launching shell exported.
//
// Marker-guarded and idempotent: the block is rewritten in place on reinstall,
// never duplicated, and a runtime `case` guard keeps PATH from growing even
// when several rc files (e.g. .zshrc + .zprofile) each source it. No sudo —
// everything written is under $HOME. Append-only: never touches the user's
// existing lines.
export function ensureBinOnShellPath(binDir: string, home: string = homedir()): void {
  const dir = binDir.startsWith(home + '/') ? `$HOME${binDir.slice(home.length)}` : binDir;
  const BEGIN = '# >>> airglow PATH >>>';
  const END = '# <<< airglow PATH <<<';
  const block =
    `${BEGIN}\n` +
    '# Added by `airglow install` — puts the airglow CLI on PATH for coding agents.\n' +
    `case ":$PATH:" in *":${dir}:"*) ;; *) export PATH="${dir}:$PATH" ;; esac\n` +
    `${END}\n`;

  // Cover both the login file (GUI-launched agents spawn login shells) and the
  // interactive file (terminal agents inherit an interactive shell's env).
  const shell = basename(process.env.SHELL || '');
  const f = (name: string) => join(home, name);
  const files =
    shell === 'zsh' ? [f('.zshrc'), f('.zprofile')]
    : shell === 'bash' ? [f('.bashrc'), existsSync(f('.bash_profile')) ? f('.bash_profile') : f('.profile')]
    : [f('.profile')];

  for (const file of files) {
    try {
      let current = '';
      try { current = readFileSync(file, 'utf8'); } catch {}
      const b = current.indexOf(BEGIN);
      let next: string;
      if (b !== -1) {
        const e = current.indexOf(END, b);
        if (e === -1) continue; // malformed block — leave the file untouched
        next = current.slice(0, b) + block.trimEnd() + current.slice(e + END.length);
      } else if (current === '') {
        next = block;
      } else {
        next = current + (current.endsWith('\n') ? '' : '\n') + '\n' + block;
      }
      if (next !== current) {
        writeFileSync(file, next);
        console.log(`PATH: updated ${file}`);
      }
    } catch (e: any) {
      console.error(`could not update ${file} for PATH: ${e?.message ?? e}`);
    }
  }
}

// The executable Chrome should spawn.
function hostExecutablePath(): string {
  const isCompiled = Bun.main.includes('$bunfs');
  if (isCompiled) return process.execPath;
  const launcher = join(STATE_DIR, 'host-launcher.sh');
  const next =
    `#!/bin/bash\n` +
    `# Generated by \`airglow install\` — do not edit.\n` +
    `exec ${shellQuote(process.execPath)} run ${shellQuote(Bun.main)} "$@"\n`;
  let current: string | null = null;
  try { current = readFileSync(launcher, 'utf8'); } catch {}
  if (current !== next) writeFileSync(launcher, next);
  chmodSync(launcher, 0o755);
  return launcher;
}

export async function runInstall(argv: string[]): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    console.error(`airglow install: ${process.platform} is not supported (macOS and Linux only)`);
    process.exit(1);
  }
  ensureStateDirs();
  const binDir = ensureAirglowOnPath(); // also writes the `bun` shim agents rely on
  ensureBinOnShellPath(binDir); // make the CLI discoverable to agents the user runs here
  await seedWorkspace();

  const extraDirs = argv.filter((a) => !a.startsWith('-'));
  const manifest = {
    name: HOST_NAME,
    description: 'Airglow native host — local app server and browser bridge',
    path: hostExecutablePath(),
    type: 'stdio',
    allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
  };

  // Auto-detected browser dirs: skip those whose parent (= browser data dir)
  // is absent. Extra positional args (e.g. a dev profile's user-data-dir) are
  // written unconditionally.
  const auto = manifestDirs().filter(({ dir }) => existsSync(dirname(dir)));
  const dirs = [...auto, ...extraDirs.map((dir) => ({ name: 'custom', dir: join(dir, 'NativeMessagingHosts') }))];

  if (dirs.length === 0) {
    console.error('no Chromium-based browser detected — nothing to install');
    process.exit(1);
  }

  let written = 0;
  for (const { name, dir } of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${HOST_NAME}.json`);
      const next = JSON.stringify(manifest, null, 2);
      let current: string | null = null;
      try { current = readFileSync(file, 'utf8'); } catch {}
      if (current !== next) {
        writeFileSync(file, next);
        console.log(`installed for ${name}: ${file}`);
        written++;
      } else {
        console.log(`up to date for ${name}: ${file}`);
      }
    } catch (e: any) {
      console.error(`failed for ${name} at ${dir}: ${e?.message ?? e}`);
    }
  }
  console.log(`\nworkspace: ${AIRGLOW_HOME}`);
  // Chrome reads NM manifests per connection attempt and the extension
  // retries every few seconds — no browser restart needed in either install
  // order. Keep a fallback hint for the rare stuck case.
  console.log('If Chrome with the Airglow extension is running, it connects automatically within a few seconds.');
  console.log('(Not connecting? Fully quitting and reopening Chrome always resolves it.)');
}
