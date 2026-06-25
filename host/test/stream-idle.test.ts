// Regression tests for the "Thinking forever" hang: the gateway opens the SSE
// stream (message_start, then a thinking block) and the socket goes silently
// half-open — no more bytes, no FIN, no error. Before the idle-timeout guard,
// consumeStream's reader.read() blocked indefinitely, so the turn never ended,
// the daemon kept Session.running=true, and the sidepanel spun on "Thinking"
// with no way to recover. These drive the real Session + streamMessage against a
// mock SSE upstream that stalls, and pin the recovery behaviour.
//
//   bun test
//
// AIRGLOW_HOME + the short idle window must be set BEFORE the project modules
// load, so the imports are dynamic and come after the env is set below.
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEnv } from '../src/agent/session.ts';

const home = mkdtempSync(join(tmpdir(), 'airglow-stream-idle-'));
process.env.AIRGLOW_HOME = home;
delete process.env.ANTHROPIC_API_KEY; // force the gateway (not direct-Anthropic) path
process.env.AIRGLOW_STREAM_IDLE_MS = '250'; // drive the 60s idle guard down for the test

const { SESSIONS_DIR } = await import('../src/paths.ts');
const { Session } = await import('../src/agent/session.ts');
mkdirSync(SESSIONS_DIR, { recursive: true });

// Mock gateway. Emits message_start + content_block_start(thinking), then for
// the first `stalls` requests it leaves the body open forever (never closes,
// never emits another byte) — the exact half-open shape. The client's idle
// guard must cancel and retry. After the stalls it returns a normal completion.
function mockGateway(opts: { stalls: number; finalText: string }) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0, // never let the server close first — the client guard must win
    async fetch() {
      const stall = ++calls <= opts.stalls;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          const send = (o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          send({ type: 'message_start', message: { model: 'claude-opus-4-8', usage: {} } });
          send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
          if (stall) return; // leave the stream open and silent — no close, no more events
          send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-xyz' } });
          send({ type: 'content_block_stop', index: 0 });
          send({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
          send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: opts.finalText } });
          send({ type: 'content_block_stop', index: 1 });
          send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
          send({ type: 'message_stop' });
          c.close();
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    },
  });
  return { server, calls: () => calls };
}

function agentEnv(): AgentEnv {
  return {
    workspace: home,
    daemonOrigin: () => 'http://127.0.0.1:3222',
    daemonLogPath: join(home, 'daemon.log'),
    airglowBinDir: home,
    listApps: async () => [],
    currentTab: async () => null,
  };
}

async function runTurn(opts: Parameters<typeof mockGateway>[0]) {
  const { server, calls } = mockGateway(opts);
  process.env.AIRGLOW_GATEWAY_URL = `http://127.0.0.1:${server.port}`;
  const events: any[] = [];
  const s = new Session(`t-${Math.random().toString(36).slice(2)}`, agentEnv(), (_id, e) => events.push(e));
  await s.sendMessage('reproduce please');
  server.stop(true);
  return { events, calls: calls() };
}

test('a half-open (silent) stream does not hang — it times out and the turn ends', async () => {
  // A single stall then recovery: the guard must fire (not block forever) and
  // the turn must complete with the recovered answer.
  const { events, calls } = await runTurn({ stalls: 1, finalText: 'Recovered answer.' });
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  const done = events.find((e) => e.type === 'turn_done');
  expect(calls).toBe(2); // one stall (timed out), then the real answer
  expect(text).toBe('Recovered answer.');
  expect(done?.stopReason).toBe('end_turn');
  expect(events.some((e) => e.type === 'error')).toBe(false);
}, 10_000);

test('a transient stall surfaces a reconnecting indicator (not silent)', async () => {
  // The user must see that something went wrong even when it self-heals.
  const { events } = await runTurn({ stalls: 1, finalText: 'Recovered answer.' });
  const reconnect = events.find((e) => e.type === 'reconnecting');
  expect(reconnect).toBeTruthy();
  expect(reconnect.attempt).toBeGreaterThanOrEqual(1);
}, 10_000);

test('a persistently silent stream surfaces an error, never an endless spinner', async () => {
  const { events } = await runTurn({ stalls: 99, finalText: '' });
  expect(events.some((e) => e.type === 'error')).toBe(true);
  const done = events.find((e) => e.type === 'turn_done');
  expect(done?.stopReason).toBe('error');
}, 15_000);
