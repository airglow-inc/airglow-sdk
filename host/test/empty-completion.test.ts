// Regression tests for the "agent just stopped talking" bug: a gateway/upstream
// SSE stream cut mid-thinking yields an empty assistant turn. These drive the
// real Session + streamMessage against a mock SSE upstream (no UI, no network),
// and pin the loop's handling of a truncated stream.
//
//   bun test
//
// AIRGLOW_HOME + ANTHROPIC_API_KEY must be set BEFORE the project modules load
// (they read both at import time), so the project imports are dynamic and come
// after the env is set below.
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEnv } from '../src/agent/session.ts';

const home = mkdtempSync(join(tmpdir(), 'airglow-empty-completion-'));
process.env.AIRGLOW_HOME = home;
delete process.env.ANTHROPIC_API_KEY; // force the gateway (not direct-Anthropic) path

const { SESSIONS_DIR } = await import('../src/paths.ts');
const { Session } = await import('../src/agent/session.ts');
const { streamMessage } = await import('../src/agent/api.ts');
mkdirSync(SESSIONS_DIR, { recursive: true });

// Mock gateway. Emits message_start + content_block_start(thinking). For the
// first `truncations` requests it then closes the body (no signature, no
// message_stop) — the exact persisted shape. With emitErrorEvent it first sends
// the terminal error event the real gateway now appends on a cut. After the
// truncations it returns a normal, complete completion.
function mockGateway(opts: { truncations: number; finalText: string; emitErrorEvent?: boolean }) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch() {
      const truncate = ++calls <= opts.truncations;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          const send = (o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          send({ type: 'message_start', message: { model: 'claude-opus-4-8', usage: {} } });
          send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
          if (truncate) {
            if (opts.emitErrorEvent) {
              send({ type: 'error', error: { type: 'upstream_truncated', message: 'the model response was cut off before it completed (upstream truncated)' } });
            }
            c.close();
            return;
          }
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
  const s = new Session(`t-${calls()}-${Math.random().toString(36).slice(2)}`, agentEnv(), (_id, e) => events.push(e));
  await s.sendMessage('reproduce please');
  server.stop(true);
  return { events, calls: calls() };
}

test('a truncated stream returns the exact persisted shape ({thinking:"",signature:""}, end_turn)', async () => {
  const { server } = mockGateway({ truncations: 1, finalText: '' });
  process.env.AIRGLOW_GATEWAY_URL = `http://127.0.0.1:${server.port}`;
  const completed = await streamMessage(
    { model: 'claude-opus-4-8', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] },
    { userId: null, email: null },
    { onTextDelta: () => {}, onToolUseStart: () => {}, onThinkingStart: () => {} },
  );
  server.stop(true);
  expect(completed.content).toEqual([{ type: 'thinking', thinking: '', signature: '' }] as any);
  expect(completed.stopReason).toBe('end_turn');
});

test('a transient truncation is retried and recovered (no error surfaced)', async () => {
  const { events, calls } = await runTurn({ truncations: 2, finalText: 'Recovered answer.' });
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  const done = events.find((e) => e.type === 'turn_done');
  expect(calls).toBe(3); // two empty completions, then the real answer
  expect(text).toBe('Recovered answer.');
  expect(done?.stopReason).toBe('end_turn');
  expect(events.some((e) => e.type === 'error')).toBe(false);
});

test('a persistent truncation surfaces an error, never a silent end_turn', async () => {
  const { events } = await runTurn({ truncations: 99, finalText: '' });
  expect(events.some((e) => e.type === 'error')).toBe(true);
  const done = events.find((e) => e.type === 'turn_done');
  expect(done?.stopReason).toBe('error');
});

// The gateway appends an `upstream_truncated` error event when a stream cuts.
// That is the SAME failure as a bare mid-stream close, just with a cleaner
// signal — so the host treats it identically: retry in place when nothing has
// streamed to the UI yet (transient cuts self-heal), and surface an error only
// when it persists. This unifies the two truncation signals (cf. the bare-close
// cases above), instead of the old split where an error event surfaced
// immediately while a bare close was retried.
test('a transient gateway truncation-error event is retried and recovered', async () => {
  const { events, calls } = await runTurn({ truncations: 1, finalText: 'Recovered answer.', emitErrorEvent: true });
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  const done = events.find((e) => e.type === 'turn_done');
  expect(calls).toBe(2); // one truncation-error event, then the real answer
  expect(text).toBe('Recovered answer.');
  expect(done?.stopReason).toBe('end_turn');
  expect(events.some((e) => e.type === 'error')).toBe(false);
}, 10_000);

test('a persistent gateway truncation-error event surfaces an error, never a silent end_turn', async () => {
  const { events } = await runTurn({ truncations: 99, finalText: '', emitErrorEvent: true });
  const err = events.find((e) => e.type === 'error');
  const done = events.find((e) => e.type === 'turn_done');
  expect(err).toBeTruthy();
  expect(done?.stopReason).toBe('error');
}, 15_000);
