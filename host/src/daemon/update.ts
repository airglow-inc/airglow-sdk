// Host self-update. Discovery: newest GitHub release tagged host-v* that
// carries this platform's binary asset (same logic as install.sh). Update:
// download → verify against the release's SHA256SUMS → atomic swap over the
// running binary → spawn the new binary with explicit --workspace, whose
// takeover semantics (SIGTERM + lock handoff) replace this process.
//
// Never silent: only the dashboard's Update button (or `airglow update`)
// triggers this. Source runs refuse — maintainers update via git.

import { chmodSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOST_VERSION } from '../version';

const REPO = 'airglow-inc/airglow-sdk';

export function isCompiledBinary(): boolean {
  return Bun.main.includes('$bunfs');
}

function platformAsset(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'airglow-darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'airglow-darwin-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'airglow-linux-x64';
  return null;
}

// "0.1.10" > "0.1.9" — numeric per segment, missing segments are 0.
function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return Number.isFinite(x) && Number.isFinite(y) ? x > y : false;
  }
  return false;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  // 'source' runs can't self-update; 'unsupported' = no binary for platform.
  mode: 'binary' | 'source' | 'unsupported';
  tag?: string;
  assetUrl?: string;
  sumsUrl?: string;
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const base: UpdateCheck = { current: HOST_VERSION, latest: null, updateAvailable: false, mode: 'binary' };
  if (!isCompiledBinary()) return { ...base, mode: 'source' };
  const asset = platformAsset();
  if (!asset) return { ...base, mode: 'unsupported' };

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub releases query failed (${res.status})`);
  const releases = (await res.json()) as any[];
  for (const rel of releases) {
    const tag = String(rel?.tag_name ?? '');
    if (!tag.startsWith('host-v')) continue;
    const assets: any[] = Array.isArray(rel?.assets) ? rel.assets : [];
    const bin = assets.find((a) => a?.name === asset);
    if (!bin) continue;
    const latest = tag.slice('host-v'.length);
    return {
      ...base,
      latest,
      tag,
      updateAvailable: isNewer(latest, HOST_VERSION),
      assetUrl: String(bin.browser_download_url),
      sumsUrl: assets.find((a) => a?.name === 'SHA256SUMS')
        ? String(assets.find((a) => a?.name === 'SHA256SUMS').browser_download_url)
        : undefined,
    };
  }
  return base; // no host release published yet
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

// Downloads + verifies + swaps the binary. With a workspace, also spawns the
// replacement daemon, whose takeover evicts this process; without one (CLI
// update with no daemon running) it just swaps and returns.
export async function performUpdate(workspace?: string): Promise<{ updatingTo: string }> {
  const check = await checkForUpdate();
  if (check.mode === 'source') throw new Error('running from source — update with git, not self-update');
  if (check.mode === 'unsupported') throw new Error(`no release binary for ${process.platform}/${process.arch}`);
  if (!check.updateAvailable || !check.assetUrl || !check.latest) {
    throw new Error(`already up to date (v${HOST_VERSION})`);
  }

  const res = await fetch(check.assetUrl, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`binary download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  if (check.sumsUrl) {
    const sums = await (await fetch(check.sumsUrl, { signal: AbortSignal.timeout(15_000) })).text();
    const expected = sums.split('\n').find((l) => l.trim().endsWith(platformAsset()!))?.trim().split(/\s+/)[0];
    if (!expected) throw new Error('SHA256SUMS has no entry for this platform');
    const actual = await sha256Hex(bytes);
    if (actual !== expected) throw new Error(`checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }

  // Write next to the live binary, then rename over it — atomic on the same
  // filesystem, and replacing a running executable is safe (the old inode
  // stays alive for this process).
  const target = process.execPath;
  const staging = join(dirname(target), `.airglow.update.${process.pid}`);
  await Bun.write(staging, bytes);
  chmodSync(staging, 0o755);
  try {
    renameSync(staging, target);
  } catch (e) {
    try { unlinkSync(staging); } catch {}
    throw e;
  }

  // Hand off: the explicit --workspace start takes over (SIGTERMs us). Detach
  // stdio — the new daemon tees its own log.
  if (workspace) {
    setTimeout(() => {
      Bun.spawn([target, 'daemon', '--workspace', workspace], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
    }, 300);
  }

  return { updatingTo: check.latest };
}

// `airglow update` from a terminal: route through the running daemon when
// there is one (so the respawn handoff happens), otherwise swap in place.
export async function runUpdateCli(): Promise<void> {
  const { probeDaemonStatus } = await import('./index');
  try {
    const daemonStatus = await probeDaemonStatus();
    if (daemonStatus.ok) {
      const daemon = daemonStatus.record;
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/daemon/update`, { method: 'POST' });
      const body: any = await res.json().catch(() => ({}));
      if (body?.ok) {
        console.log(`updating v${HOST_VERSION} → v${body.updatingTo}; the daemon restarts itself.`);
        return;
      }
      throw new Error(String(body?.error ?? `daemon responded ${res.status}`));
    }
    if (daemonStatus.record && daemonStatus.pidAlive) {
      throw new Error(`daemon pid ${daemonStatus.record.pid} is alive on http://127.0.0.1:${daemonStatus.record.port}, but its local API is unreachable${daemonStatus.message ? `: ${daemonStatus.message}` : ''}`);
    }
    const { updatingTo } = await performUpdate();
    console.log(`updated v${HOST_VERSION} → v${updatingTo}`);
  } catch (e: any) {
    console.error(`update failed: ${e?.message ?? e}`);
    process.exit(1);
  }
}
