// Tests for mid-turn follow-ups: a message the user sends while the agent is
// still working is woven into the live conversation and addressed in the same
// turn, instead of being rejected. Drives the real Session + streamMessage
// against a mock SSE upstream (no UI, no network).
//
//   bun test
//
// AIRGLOW_HOME + ANTHROPIC_API_KEY must be set BEFORE the project modules load
// (they read both at import time), so the project imports are dynamic.
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEnv } from '../src/agent/session.ts';

const home = mkdtempSync(join(tmpdir(), 'airglow-followup-'));
process.env.AIRGLOW_HOME = home;
delete process.env.ANTHROPIC_API_KEY; // force the gateway (not direct-Anthropic) path

const { SESSIONS_DIR } = await import('../src/paths.ts');
const { Session } = await import('../src/agent/session.ts');
mkdirSync(SESSIONS_DIR, { recursive: true });

// Mock gateway. Each request returns a normal, complete end_turn completion
// whose text is `texts[callIndex]` (the last text repeats once exhausted).
// `onCall(n)` fires synchronously inside fetch (n = 1-based) — i.e. while the
// loop awaits this step — so a test can enqueue a follow-up mid-turn with
// deterministic timing.
function mockGateway(texts: string[], onCall?: (n: number) => void) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch() {
      const n = ++calls;
      onCall?.(n);
      const text = texts[Math.min(n - 1, texts.length - 1)] ?? '';
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          const send = (o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          send({ type: 'message_start', message: { model: 'claude-opus-4-8', usage: {} } });
          send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
          send({ type: 'content_block_stop', index: 0 });
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

function userTexts(messages: any[]): string[] {
  return messages
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content)
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text);
}

test('a follow-up sent mid-turn continues the turn and reaches the model', async () => {
  let session: any;
  // On the first model step (while the agent is "working"), the user sends a
  // follow-up. The loop should fold it in and keep going rather than ending.
  const { server, calls } = mockGateway(['First answer.', 'Second answer.'], (n) => {
    if (n === 1) session.enqueueFollowup('also do the second thing');
  });
  process.env.AIRGLOW_GATEWAY_URL = `http://127.0.0.1:${server.port}`;
  const events: any[] = [];
  session = new Session('t-steer', agentEnv(), (_id, e) => events.push(e));
  await session.sendMessage('do the first thing');
  server.stop(true);

  // Two model steps: the original answer, then the follow-up addressed.
  expect(calls()).toBe(2);
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('|');
  expect(text).toBe('First answer.|Second answer.');

  // Exactly one turn_done — the turn never ended between the two answers.
  const dones = events.filter((e) => e.type === 'turn_done');
  expect(dones.length).toBe(1);
  expect(dones[0].stopReason).toBe('end_turn');

  // The follow-up landed in history as a user message the model could read.
  expect(userTexts(session.getMessages()).some((t) => t.includes('also do the second thing'))).toBe(true);
});

test('no follow-up → the turn ends after a single model step', async () => {
  const { server, calls } = mockGateway(['Just the one answer.']);
  process.env.AIRGLOW_GATEWAY_URL = `http://127.0.0.1:${server.port}`;
  const events: any[] = [];
  const session = new Session('t-plain', agentEnv(), (_id, e) => events.push(e));
  await session.sendMessage('do a thing');
  server.stop(true);

  expect(calls()).toBe(1);
  expect(events.filter((e) => e.type === 'turn_done').length).toBe(1);
});

test('a follow-up queued during an aborted turn is dropped, not leaked', async () => {
  let session: any;
  const { server } = mockGateway(['answer'], (n) => {
    if (n === 1) { session.enqueueFollowup('late message'); session.stop(); }
  });
  process.env.AIRGLOW_GATEWAY_URL = `http://127.0.0.1:${server.port}`;
  const events: any[] = [];
  session = new Session('t-abort', agentEnv(), (_id, e) => events.push(e));
  await session.sendMessage('start');
  server.stop(true);

  // The stop unwinds the turn; the queued follow-up must not survive into history.
  expect(userTexts(session.getMessages()).some((t) => t.includes('late message'))).toBe(false);
});
