// Discovery registry for Airglow trace hosts.
//
// Each running native-messaging host writes one JSON record describing where
// its HTTP bridge is listening, so external tools (the agent, the dom script,
// `airglow dev`) can find it even when the default port was busy and the host
// fell back to a random one. Records live in a global, browser-agnostic dir
// because the host is spawned by Chrome and has no reliable view of any
// workspace cwd.
//
// One file per host, named by pid. Self-healing: readers prune records whose
// process is gone, covering hard kills where the host's own exit hook didn't run.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const REGISTRY_DIR = path.join(os.homedir(), '.airglow', 'hosts');

export function recordPath(pid) {
  return path.join(REGISTRY_DIR, `${pid}.json`);
}

export function writeHostRecord(rec) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(recordPath(rec.pid), JSON.stringify(rec, null, 2));
  return recordPath(rec.pid);
}

export function removeHostRecord(pid) {
  try { fs.unlinkSync(recordPath(pid)); } catch {}
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = exists but not ours
}

// Read all live host records, pruning dead ones. Newest first.
export function readHostRecords({ prune = true } = {}) {
  let files = [];
  try { files = fs.readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json')); }
  catch { return []; }
  const recs = [];
  for (const f of files) {
    const full = path.join(REGISTRY_DIR, f);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    if (prune && !isAlive(rec.pid)) { try { fs.unlinkSync(full); } catch {} continue; }
    recs.push(rec);
  }
  return recs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

// macOS: derive the --user-data-dir of the parent (Chrome) process, so a record
// can be tied back to the workspace that launched the browser via `pnpm chrome`
// (its profile lives at <workspace>/.airglow/chrome-profile).
export function parentUserDataDir(ppid) {
  try {
    const out = execFileSync('ps', ['-p', String(ppid), '-o', 'command='], { encoding: 'utf8' });
    const m = out.match(/--user-data-dir=(\S+)/);
    return m ? m[1] : null;
  } catch { return null; }
}
