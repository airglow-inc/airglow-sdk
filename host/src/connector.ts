// Connector — the process Chrome spawns via native messaging (one per running
// browser). Thin by design: find-or-spawn the daemon, then bridge
// native-messaging stdio ⇄ daemon WebSocket. All real work happens in the
// daemon so every Chrome shares one workspace.

import { execFileSync } from 'node:child_process';
import { probeDaemon } from './daemon/index';
import { writeNativeMessage, readNativeMessages } from './native-messaging';
import { ensureStateDirs, type DaemonRecord } from './paths';
import { HOST_VERSION } from './version';

const DAEMON_SPAWN_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 2000;

function log(msg: string): void {
  process.stderr.write(`[airglow-connector] ${msg}\n`);
}

// Derive the parent Chrome's --user-data-dir so the daemon can tell multiple
// browsers apart (default profile Chromes report null — still distinguishable
// by connector identity).
function parentUserDataDir(): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(process.ppid), '-o', 'command='], { encoding: 'utf8' });
    const m = out.match(/--user-data-dir=(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function ensureDaemon(): Promise<DaemonRecord> {
  const existing = await probeDaemon();
  if (existing) return existing;

  // Spawned detached-ish: the child is not in our process group's signal path
  // and unref lets the connector exit independently. The daemon tees its own
  // output to state/daemon.log.
  const isCompiled = Bun.main.includes('$bunfs');
  const cmd = isCompiled
    ? [process.execPath, 'daemon']
    : [process.execPath, 'run', Bun.main, 'daemon'];
  log(`spawning daemon: ${cmd.join(' ')}`);
  const child = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  child.unref();

  const deadline = Date.now() + DAEMON_SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(300);
    const record = await probeDaemon();
    if (record) return record;
  }
  throw new Error('daemon did not come up within 15s');
}

export async function runConnector(): Promise<void> {
  ensureStateDirs();

  let ws: WebSocket | null = null;
  let stdinOpen = true;
  // Messages from the extension that arrive while the daemon link is down are
  // dropped after this queue limit — replies time out daemon-side anyway.
  const sendQueue: any[] = [];

  function flushQueue(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (sendQueue.length > 0) {
      ws.send(JSON.stringify({ t: 'ext', msg: sendQueue.shift() }));
    }
  }

  async function connect(): Promise<void> {
    let record: DaemonRecord;
    try {
      record = await ensureDaemon();
    } catch (e: any) {
      log(`daemon unavailable: ${e?.message || e}`);
      if (stdinOpen) setTimeout(connect, RECONNECT_DELAY_MS);
      return;
    }

    const socket = new WebSocket(`ws://127.0.0.1:${record.port}/ws?token=${encodeURIComponent(record.token)}`);
    ws = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({
        t: 'register',
        pid: process.pid,
        userDataDir: parentUserDataDir(),
        version: HOST_VERSION,
      }));
    };

    socket.onmessage = (evt) => {
      let msg: any;
      try { msg = JSON.parse(String(evt.data)); } catch { return; }
      if (msg?.t === 'registered') {
        log(`registered with daemon on :${record.port}`);
        // Handshake to the extension: where the daemon lives. The background
        // stores this as the local app source origin.
        writeNativeMessage({
          type: 'ready',
          daemonOrigin: `http://127.0.0.1:${record.port}`,
          daemonVersion: msg.version,
          httpPort: record.port,
        });
        flushQueue();
      } else if (msg?.t === 'ext') {
        writeNativeMessage(msg.msg);
      }
    };

    socket.onclose = () => {
      if (ws === socket) ws = null;
      if (stdinOpen) {
        log('daemon link lost — reconnecting');
        setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  readNativeMessages(
    (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'ext', msg }));
      } else if (sendQueue.length < 200) {
        sendQueue.push(msg);
      }
    },
    () => {
      // Chrome closed the pipe (browser quit or extension reloaded).
      stdinOpen = false;
      try { ws?.close(); } catch {}
      process.exit(0);
    },
  );

  await connect();
}
