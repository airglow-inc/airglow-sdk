import type { DaemonRecord } from '../paths';
import { probeDaemonStatus, type DaemonProbeStatus } from '../daemon/index';

const START_HINT = 'airglow daemon is not running. It starts automatically when Chrome (with the Airglow extension) is open.';

export function formatDaemonProbeFailure(status: Exclude<DaemonProbeStatus, { ok: true }>): string {
  if (status.reason === 'no-record') return START_HINT;

  const record = status.record;
  const origin = record ? `http://127.0.0.1:${record.port}` : 'the recorded daemon origin';
  const processState = status.pidAlive === true ? `pid ${record?.pid} is alive` : `pid ${record?.pid ?? '?'} is not alive`;
  const detail = status.message ? `\nprobe failed: ${status.message}` : '';

  if (status.reason === 'unreachable') {
    const sandboxHint = status.pidAlive === true
      ? '\nIf this command is running in a sandboxed agent, allow local 127.0.0.1 access and retry.'
      : '';
    return `airglow daemon record exists for ${origin}, but its local API is unreachable (${processState}).${detail}${sandboxHint}`;
  }

  return `airglow daemon at ${origin} did not pass the health check (${processState}).${detail}`;
}

export async function requireDaemon(): Promise<DaemonRecord> {
  const status = await probeDaemonStatus();
  if (status.ok) return status.record;
  console.error(formatDaemonProbeFailure(status));
  process.exit(1);
}
