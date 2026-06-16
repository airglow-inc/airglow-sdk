// Filesystem layout. Everything Airglow owns on the user's machine lives
// under one root (default ~/.airglow, overridable via AIRGLOW_HOME for tests).
//
//   ~/.airglow/
//     apps/<app-id>/       user apps (source, user-editable)
//     shared/              managed assets (theme, fonts) — overwritten on update
//     docs/                managed agent-facing docs
//     AGENTS.md            managed workspace instructions
//     bin/                 installed binary (written by the installer)
//     state/               daemon record, logs, sessions, screenshots
//
// The workspace root IS the airglow home: the daemon scans it recursively for
// manifest.json files (so both apps/<id> and legacy root-level layouts work).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const AIRGLOW_HOME = process.env.AIRGLOW_HOME || join(homedir(), '.airglow');

export const STATE_DIR = join(AIRGLOW_HOME, 'state');
export const DAEMON_RECORD_PATH = join(STATE_DIR, 'daemon.json');
export const DAEMON_LOCK_PATH = join(STATE_DIR, 'daemon.lock');
export const DAEMON_LOG_PATH = join(STATE_DIR, 'daemon.log');
// Persisted workspace preference. Written when the daemon is started with an
// explicit --workspace, read by connector-spawned daemons so every spawn
// serves the same workspace (maintainers point it at a repo checkout once).
export const WORKSPACE_CONFIG_PATH = join(STATE_DIR, 'workspace');
export const SHOTS_DIR = join(STATE_DIR, 'shots');
export const SESSIONS_DIR = join(STATE_DIR, 'sessions');

export const DEFAULT_DAEMON_PORT = 3222;

export function ensureStateDirs(): void {
  for (const dir of [AIRGLOW_HOME, STATE_DIR, SHOTS_DIR, SESSIONS_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

export interface DaemonRecord {
  pid: number;
  port: number;
  workspace: string;
  version: string;
  startedAt: number;
  // Per-daemon secret required to open the privileged `/ws` socket. Written to
  // this record (mode 0600, only the user can read it) and presented by the
  // native connector. A web page can reach 127.0.0.1 but cannot read this file,
  // so it cannot forge the socket that drives the autonomous agent.
  token: string;
}
