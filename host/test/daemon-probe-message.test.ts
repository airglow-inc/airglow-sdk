import { expect, test } from 'bun:test';
import { formatDaemonProbeFailure } from '../src/cli/daemon';

const record = {
  pid: 12345,
  port: 3222,
  workspace: '/Users/test/.airglow',
  version: '0.2.2',
  startedAt: 1,
  token: 'test-token',
};

test('no daemon record keeps the existing Chrome startup hint', () => {
  expect(formatDaemonProbeFailure({ ok: false, reason: 'no-record', record: null })).toBe(
    'airglow daemon is not running. It starts automatically when Chrome (with the Airglow extension) is open.',
  );
});

test('unreachable live daemon is not reported as not running', () => {
  const message = formatDaemonProbeFailure({
    ok: false,
    reason: 'unreachable',
    record,
    pidAlive: true,
    message: 'FailedToOpenSocket: Was there a typo in the url or port?',
  });

  expect(message).toContain('daemon record exists for http://127.0.0.1:3222');
  expect(message).toContain('local API is unreachable');
  expect(message).toContain('pid 12345 is alive');
  expect(message).toContain('allow local 127.0.0.1 access');
  expect(message).not.toContain('daemon is not running');
});
