// Agent sessions — the harness loop. One Session per conversation; the
// SessionManager owns them and is the daemon's entry point for agent traffic.
//
// Persistence: one JSONL file per session under state/sessions/. Lines are
// {type:'meta'} (latest wins) and {type:'message'} (Anthropic-format message,
// replayed in order on resume). Message lines also carry a wall-clock `ts` so
// chat UIs can reconstruct each turn's "Worked for X" duration after reload.

import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SESSIONS_DIR } from '../paths';
import { AGENT_EFFORT, agentModel, streamMessage, type AgentIdentity } from './api';
import { getSystemPromptPrefix, promptRuntimeContext } from './prompt';
import { SERVER_TOOL_DEFINITIONS, TOOL_DEFINITIONS, Tools } from './tools';
import type { AgentEvent, ApiMessage, ContentBlock, SessionMeta } from './types';

const MAX_LOOP_ITERATIONS = 80;
const MAX_TOKENS = 32_000;
// High reasoning effort. Thinking blocks stay in history (the API requires
// them intact through tool loops) but are never surfaced to chat clients.

export type UserImage = { media_type: string; data: string };

export type EventSink = (sessionId: string, event: AgentEvent) => void;

// The foreground tab in the Chrome window driving this session.
export type CurrentTab = { id: number; title: string; url?: string };

export interface AgentEnv {
  workspace: string;
  daemonOrigin: () => string;
  daemonLogPath: string;
  // chrome.runtime.id of the browser driving this session, or null before its
  // connector announces identity. Per session, so each agent gets ITS browser's
  // dashboard chrome-extension:// URL (dev and Web Store builds differ).
  extensionId?: (sessionId: string) => string | null;
  // Directory containing an `airglow` executable (PATH injection for bash).
  airglowBinDir: string;
  // Existing apps: id + workspace-relative directory (for the prompt).
  listApps: () => Promise<{ id: string; dir: string }[]>;
  // Active tab the user is looking at in the chat's Chrome window, resolved at
  // send time. null when no browser/tab is available.
  currentTab: (sessionId: string) => Promise<CurrentTab | null>;
  // Ask the session's chat client (extension) to silently re-mint the user's
  // session token after the gateway rejects it (AUTH_SESSION_INVALID).
  // Resolves to the fresh token, or null when no client/Google session can
  // refresh it. Optional: direct-Anthropic dev mode has no gateway auth.
  refreshAuth?: (sessionId: string) => Promise<string | null>;
  // Hold an OS power assertion while a turn runs so idle sleep can't sever the
  // model stream mid-turn (see daemon/keep-awake.ts). Refcounted across
  // sessions; acquire/release are balanced per turn. Optional (no-op off-daemon).
  keepAwake?: { acquire(): void; release(): void };
}

export class Session {
  readonly id: string;
  meta: SessionMeta;
  private messages: ApiMessage[] = [];
  // Wall-clock ms per entry in `messages` (parallel array). Drives the
  // persisted "Worked for X" duration on history reload; message-append lines
  // don't add an entry. 0 for pre-timestamp (legacy) message lines.
  private times: number[] = [];
  running = false;
  // Wall-clock ms when the current turn began (null when idle). Lets a
  // reopened sidepanel show the true elapsed time instead of restarting the
  // "Working for X" clock from zero.
  turnStartedAt: number | null = null;
  // Index in `messages` of the user message that opened the current turn. A
  // reopened panel rebuilds completed turns from history up to here, then
  // replays the live event buffer for the in-flight turn (no double-render).
  private turnStartIndex = 0;
  identity: AgentIdentity = { userId: null, email: null };
  private abort: AbortController | null = null;
  // Last tab snapshot injected into a user message; re-sent only when the tab
  // (id/title/url) changes, so unchanged turns don't repeat it.
  private lastTabContext: string | null = null;
  // Follow-up messages the user sent while this turn was running. Each entry is
  // its content blocks plus the panel's optimistic-send id; the loop drains them
  // into the conversation at the next boundary (after the current tool batch, or
  // instead of ending the turn) so the agent reacts to them mid-task. Draining
  // emits followup_injected with the entries' clientIds so chat clients drop the
  // "in queue" pill. See enqueueFollowup / drainPending.
  private pendingInput: { blocks: ContentBlock[]; clientId?: string }[] = [];

  constructor(id: string, private env: AgentEnv, private sink: EventSink) {
    this.id = id;
    this.meta = { id, title: null, appId: null, appName: null, createdAt: Date.now(), updatedAt: Date.now() };
  }

  private get filePath(): string {
    return join(SESSIONS_DIR, `${this.id}.jsonl`);
  }

  private emit(event: AgentEvent): void {
    this.sink(this.id, event);
  }

  // Always stamps turn_done with the turn's start time so the client can show
  // an accurate "Worked for X" even when it lost its own start ref mid-turn.
  private emitTurnDone(extra: Omit<Extract<AgentEvent, { type: 'turn_done' }>, 'type' | 'startedAt'>): void {
    this.emit({ type: 'turn_done', startedAt: this.turnStartedAt, ...extra });
  }

  private persist(line: Record<string, unknown>): void {
    try { appendFileSync(this.filePath, JSON.stringify(line) + '\n'); } catch {}
  }

  private persistMeta(): void {
    this.meta.updatedAt = Date.now();
    this.persist({ type: 'meta', meta: this.meta });
  }

  getMessages(): ApiMessage[] {
    return this.messages;
  }

  // Per-message wall-clock timestamps, index-aligned with getMessages().
  getMessageTimes(): number[] {
    return this.times;
  }

  getTurnStartedAt(): number | null {
    return this.turnStartedAt;
  }

  getTurnStartIndex(): number {
    return this.turnStartIndex;
  }

  // Append a new message to history and persist it with a wall-clock
  // timestamp, keeping `times` aligned with `messages`.
  private pushMessage(message: ApiMessage): void {
    const ts = Date.now();
    this.messages.push(message);
    this.times.push(ts);
    this.persist({ type: 'message', message, ts });
  }

  static load(id: string, env: AgentEnv, sink: EventSink): Session | null {
    const s = new Session(id, env, sink);
    if (!existsSync(s.filePath)) return null;
    try {
      for (const line of readFileSync(s.filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        if (rec.type === 'meta') s.meta = rec.meta;
        else if (rec.type === 'message') {
          s.messages.push(rec.message);
          s.times.push(typeof rec.ts === 'number' ? rec.ts : 0);
        } else if (rec.type === 'message-append') {
          const last = s.messages[s.messages.length - 1];
          // rec.text is the pre-images format of this line.
          const blocks: ContentBlock[] = rec.blocks ?? [{ type: 'text', text: rec.text }];
          if (last && Array.isArray(last.content)) last.content.push(...blocks);
        }
      }
      return s;
    } catch {
      return null;
    }
  }

  // Infer which app is being developed from written paths: first path segment
  // that is an app dir (contains manifest.json), or apps/<id>/ / local/<id>/.
  private noteWrite(relPath: string): void {
    const segs = relPath.split('/');
    let appDir: string | null = null;
    if ((segs[0] === 'apps' || segs[0] === 'local') && segs.length > 1) appDir = `${segs[0]}/${segs[1]}`;
    else if (segs.length > 1) appDir = segs[0];
    if (!appDir) return;
    const manifestPath = join(this.env.workspace, appDir, 'manifest.json');
    if (!existsSync(manifestPath)) return;
    let appId = appDir.split('/').pop()!;
    let name = appId;
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (m.id) appId = m.id;
      if (m.name) name = m.name;
    } catch {}
    if (this.meta.appId === appId) return;
    this.meta.appId = appId;
    this.meta.appName = name;
    this.persistMeta();
    this.emit({ type: 'app_context', appId, name });
  }

  // Interrupt the running turn: aborts the in-flight model request and any
  // running bash subprocess; the loop unwinds via the abort error.
  stop(): void {
    this.abort?.abort();
  }

  // Queue a follow-up the user sent while the turn is running. The loop weaves
  // it into the conversation at the next boundary (drainPending), so the agent
  // adjusts mid-task instead of the user waiting for the turn to end. Caller
  // routes here only while running; an idle session takes a fresh sendMessage.
  enqueueFollowup(text: string, images?: UserImage[], clientId?: string): void {
    this.pendingInput.push({ blocks: followupBlocks(text, images), clientId });
  }

  // Pull every queued follow-up into one content-block array (clears the queue).
  // Emits followup_injected for the drained entries so the panel's "in queue"
  // pill clears the moment the message actually lands in history.
  private drainPending(): ContentBlock[] {
    if (this.pendingInput.length === 0) return [];
    const out = this.pendingInput.flatMap((p) => p.blocks);
    const clientIds = this.pendingInput.map((p) => p.clientId).filter((c): c is string => !!c);
    this.pendingInput = [];
    if (clientIds.length > 0) this.emit({ type: 'followup_injected', clientIds });
    return out;
  }

  async sendMessage(text: string, images?: UserImage[]): Promise<void> {
    if (this.running) {
      this.emit({ type: 'error', message: 'agent is still working — wait for the turn to finish' });
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.turnStartedAt = Date.now();
    // The in-flight turn's user message lands at the current end of history
    // (push case) or merges into the trailing user message (resume case); a
    // reopened panel trims completed turns at this index. Set before the first
    // await so a resync mid-setup sees a stable boundary.
    this.turnStartIndex = this.messages.length;
    // Keep the machine awake for the duration of the turn (released in finally),
    // so an idle laptop on battery doesn't sleep mid-stream and drop the model
    // connection. Acquired after the running guard above, so it pairs 1:1 with
    // the release below.
    this.env.keepAwake?.acquire();
    try {
      if (!this.meta.title) {
        this.meta.title = text.slice(0, 60);
        this.persistMeta();
      }
      // After an interrupted turn the history can already end with a user
      // message (tool results); the API requires alternating roles, so merge
      // instead of pushing a second consecutive user message.
      const blocks: ContentBlock[] = (images ?? []).map((im): ContentBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: im.media_type, data: im.data },
      }));
      // The API rejects empty text blocks — image-only messages are fine.
      if (text.trim()) blocks.push({ type: 'text', text });
      if (blocks.length === 0) blocks.push({ type: 'text', text: '(empty message)' });
      // Prepend a snapshot of the page the user is looking at, so the agent can
      // act on "this page" without first running `airglow browser tabs`. Lives
      // in the user message (not the system prompt) to avoid thrashing the
      // system prompt cache each turn; chat UIs filter the <airglow-context>
      // block out of the rendered bubble. Sent only when the tab changed since
      // the last injection (id/title/url) — including the first message.
      const tab = await this.env.currentTab(this.id).catch(() => null);
      if (tab) {
        const ctx = formatTabContext(tab);
        if (ctx !== this.lastTabContext) {
          this.lastTabContext = ctx;
          blocks.unshift({ type: 'text', text: ctx });
        }
      }
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(...blocks);
        this.persist({ type: 'message-append', blocks });
      } else {
        const userMessage: ApiMessage = { role: 'user', content: blocks };
        this.pushMessage(userMessage);
      }
      await this.runLoop();
    } catch (e: any) {
      if (this.abort?.signal.aborted) {
        this.emitTurnDone({ stopReason: 'stopped' });
      } else {
        this.emit({ type: 'error', message: String(e?.message ?? e), ...(e?.code ? { code: e.code } : {}), ...(e?.resetHours ? { resetHours: e.resetHours } : {}) });
        this.emitTurnDone({
          stopReason: 'error',
          ...(typeof e?.status === 'number' ? { errorStatus: e.status } : {}),
          ...(e?.code ? { errorCode: String(e.code) } : {}),
        });
      }
    } finally {
      this.running = false;
      this.abort = null;
      // Release the power assertion taken at turn start (refcounted, so the
      // machine can idle-sleep again only once every session's turn is done).
      this.env.keepAwake?.release();
      // Drop any follow-up that raced in during an aborted/errored turn — the
      // loop already drains pending input before any clean turn end, so this
      // only clears a message the user can no longer expect to be processed.
      this.pendingInput = [];
      this.persistMeta();
    }
  }

  private async runLoop(): Promise<void> {
    const signal = this.abort!.signal;
    const tools = new Tools(this.env.workspace, this.id, this.env.airglowBinDir, signal);
    // Gateway mode: prefix is empty — the gateway injects the canonical
    // prompt server-side and appends this runtime context after it.
    const system =
      getSystemPromptPrefix() +
      promptRuntimeContext({
        workspace: this.env.workspace,
        daemonOrigin: this.env.daemonOrigin(),
        daemonLogPath: this.env.daemonLogPath,
        extensionId: this.env.extensionId?.(this.id) ?? null,
        apps: await this.env.listApps().catch(() => []),
      });

    // Consecutive truncated/empty completions — see the guard below.
    let emptyCompletions = 0;
    for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
      signal.throwIfAborted();
      const completed = await streamMessage(
        {
          model: agentModel(),
          max_tokens: MAX_TOKENS,
          // Opus 4.7+ accepts ONLY adaptive thinking (budget_tokens 400s);
          // adaptive interleaves thinking between tool calls natively.
          thinking: { type: 'adaptive' },
          output_config: { effort: AGENT_EFFORT },
          // Cache breakpoints: system (covers the tools+system prefix) and the
          // last message (so each loop iteration reads the conversation from
          // cache and only pays for the newest tool results).
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          tools: [...TOOL_DEFINITIONS, ...SERVER_TOOL_DEFINITIONS],
          messages: withCacheBreakpoint(sanitizeForApi(this.messages)),
          // Stable conversation key for the gateway's session capture; stripped
          // before hitting Anthropic directly (dev). Cloud falls back to a hash
          // of the first user message when this is absent.
          session_id: this.id,
        },
        this.identity,
        {
          onTextDelta: (t) => this.emit({ type: 'text_delta', text: t }),
          onToolUseStart: () => {},
          onThinkingStart: () => this.emit({ type: 'thinking' }),
          // Server-side web search: surface it like a local tool so chat UIs
          // show "Searching the web for …" while the API runs the search.
          onServerToolUse: (toolId, name, input) => this.emit({ type: 'tool_start', toolId, name, input }),
          onServerToolResult: (toolUseId, content) => this.emit({
            type: 'tool_end',
            toolId: toolUseId,
            name: 'web_search',
            ok: Array.isArray(content),
            summary: truncateSummary(formatWebSearchResult(content)),
          }),
        },
        signal,
        // Self-heal a rejected session token: have the extension re-mint it,
        // adopt the fresh token for this session, and retry the request.
        this.env.refreshAuth
          ? async () => {
              const token = await this.env.refreshAuth!(this.id);
              if (token) this.identity.authToken = token;
              return token;
            }
          : undefined,
        // A transient drop (network, upstream 5xx, or a stalled stream) is being
        // re-issued — tell chat clients so they show "reconnecting" instead of a
        // silent gap that looks like the model is still working.
        (attempt) => this.emit({ type: 'reconnecting', attempt }),
      );

      if (i === 0) console.log(`[agent ${this.id}] model: ${completed.model ?? '(unknown)'}`);

      // Guard against a truncated/empty completion: the stream ended without the
      // model producing any answer (no non-empty text) or action (no tool_use).
      // Seen when the upstream cuts the connection right after opening a thinking
      // block — leaving a blank {thinking:'', signature:''}. The loop used to
      // persist that and emit turn_done(end_turn), ending the chat with no reply
      // ("the agent just stopped talking"). Don't persist it; re-request a few
      // times, then surface an error instead of a silent dead-end. pause_turn is
      // a legitimate mid-message pause (server tools) and is handled below.
      const meaningful = completed.content.some(
        (b) => (b.type === 'text' && b.text.trim() !== '') || b.type === 'tool_use' || b.type === 'server_tool_use',
      );
      if (!meaningful && completed.stopReason !== 'pause_turn') {
        if (++emptyCompletions <= 2) {
          console.warn(`[agent ${this.id}] empty completion (stop ${completed.stopReason}) — retry ${emptyCompletions}/2`);
          await Bun.sleep(400 * emptyCompletions);
          continue;
        }
        this.emit({ type: 'error', message: 'The model returned an empty response — this can happen on a long turn. Send your message again to continue.' });
        this.emitTurnDone({ stopReason: 'error' });
        return;
      }
      emptyCompletions = 0;

      const assistantMessage: ApiMessage = { role: 'assistant', content: completed.content };
      this.pushMessage(assistantMessage);

      // Long server-tool turns (web search) pause mid-message; resending the
      // history as-is (ending with the assistant message) resumes the turn.
      if (completed.stopReason === 'pause_turn') continue;

      const toolUses = completed.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (completed.stopReason !== 'tool_use' || toolUses.length === 0) {
        // The model is done — but if the user sent a follow-up while it was
        // finishing, fold it in and keep going instead of ending the turn.
        const followup = this.drainPending();
        if (followup.length > 0) {
          this.pushMessage({ role: 'user', content: followup });
          continue;
        }
        this.emitTurnDone({ stopReason: completed.stopReason });
        return;
      }

      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        // On interrupt, still produce a tool_result for every tool_use block —
        // the API rejects histories with dangling tool_use on resume.
        if (signal.aborted) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: '(interrupted by the user)', is_error: true });
          continue;
        }
        this.emit({ type: 'tool_start', toolId: tu.id, name: tu.name, input: tu.input });
        if (tu.name === 'plan' && Array.isArray((tu.input as any).items)) {
          this.emit({ type: 'plan', items: (tu.input as any).items });
        }
        if (tu.name === 'task' && typeof (tu.input as any).title === 'string') {
          this.emit({ type: 'task', title: (tu.input as any).title });
        }
        const outcome = await tools.execute(tu.name, tu.input);
        if (outcome.wrotePath) this.noteWrite(outcome.wrotePath);
        this.emit({
          type: 'tool_end',
          toolId: tu.id,
          name: tu.name,
          ok: !outcome.isError && !signal.aborted,
          summary: truncateSummary(outcome.content),
        });
        const resultContent: ContentBlock & { type: 'tool_result' } = {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: outcome.images?.length
            ? [
                { type: 'text', text: outcome.content },
                ...outcome.images.map((im): import('./types').ImageBlock => ({
                  type: 'image',
                  source: { type: 'base64', media_type: im.media_type, data: im.data },
                })),
              ]
            : outcome.content,
          is_error: outcome.isError || undefined,
        };
        results.push(resultContent);
      }
      // Fold any follow-up the user sent during this batch into the same user
      // message as the tool results (the API requires results to immediately
      // follow their tool_use), so the next model step sees the new instruction.
      const resultMessage: ApiMessage = { role: 'user', content: [...results, ...this.drainPending()] };
      this.pushMessage(resultMessage);
      signal.throwIfAborted();
    }
    this.emit({ type: 'error', message: `stopped after ${MAX_LOOP_ITERATIONS} tool iterations` });
    this.emitTurnDone({ stopReason: 'max_iterations' });
  }
}

// Content blocks for a follow-up message injected mid-turn. A leading
// <airglow-context> marker (same wrapper chat UIs strip from the bubble, like
// the tab snapshot) tells the model this arrived while it was working and is a
// new instruction, not tool output. Image bytes ride along as base64 blocks.
function followupBlocks(text: string, images?: UserImage[]): ContentBlock[] {
  const blocks: ContentBlock[] = (images ?? []).map((im): ContentBlock => ({
    type: 'image',
    source: { type: 'base64', media_type: im.media_type, data: im.data },
  }));
  if (text.trim()) blocks.push({ type: 'text', text });
  blocks.unshift({
    type: 'text',
    text: '<airglow-context>The user sent a new message while you were working. Treat it as additional instructions and adjust the current task accordingly.</airglow-context>',
  });
  return blocks;
}

// One-line snapshot of the tab the user is viewing, prepended to each user
// message. The <airglow-context> wrapper is the marker chat UIs key off to
// keep this out of the rendered user bubble (sidepanel reconstructItems).
function formatTabContext(tab: CurrentTab): string {
  const title = tab.title.trim() || '(untitled)';
  const url = tab.url ? `, url ${tab.url.length > 50 ? tab.url.slice(0, 50) + '…' : tab.url}` : '';
  // Trailing newline so this block stays visually separate from the user's
  // text block that follows it in the same message.
  return `<airglow-context>Active browser tab the user is viewing now: id ${tab.id}, title "${title}"${url}.</airglow-context>\n`;
}

// Tool output as shown in chat UIs (tool_end events). The model sees the full
// content; this only bounds the UI payload (native messaging caps at 1MB).
const SUMMARY_CHARS = 5000;
function truncateSummary(text: string): string {
  if (text.length <= SUMMARY_CHARS) return text;
  return text.slice(0, SUMMARY_CHARS) + `\n…(truncated, ${text.length - SUMMARY_CHARS} more chars)`;
}

// Drop blocks that would make the API reject the whole request, then drop any
// messages that end up content-less.
//
// Cases handled:
//   - Empty text blocks ("text content blocks must be non-empty"). Adaptive
//     thinking can emit a text block that never receives deltas.
//   - Thinking blocks with an empty signature. The signature is supplied via
//     a streaming `signature_delta`; if the stream is interrupted between
//     `content_block_start` and the first delta, the block persists as
//     `{ thinking: '', signature: '' }` and Anthropic rejects every subsequent
//     replay ("thinking blocks must have a valid signature"). Same poisoning
//     pattern as empty text blocks — handle it the same way.
//
// Stored messages are never mutated.
function sanitizeForApi(messages: ApiMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      if (typeof m.content === 'string' && !m.content.trim()) continue;
      out.push(m);
      continue;
    }
    const content = m.content.filter((b: any) =>
      !(b?.type === 'text' && !String(b.text ?? '').trim()) &&
      !(b?.type === 'thinking' && !String(b.signature ?? '').trim())
    );
    if (content.length === 0) continue;
    out.push({ ...m, content });
  }
  return repairDanglingToolUse(out);
}

// Repair a history where an assistant `tool_use` block has no matching
// `tool_result` in the next message. Anthropic 400s the whole request with
// "tool_use ids were found without tool_result blocks immediately after",
// which then poisons EVERY later turn in the session (the dangling call stays
// in history and the cloud relays the 400 as a 502). It happens when a turn
// dies between persisting the assistant tool_use (runLoop) and its results — a
// tool throwing a non-abort error, or a daemon crash/kill mid-execution — and
// the user then sends another message, appending a plain user turn after the
// orphaned call. We splice a synthetic error tool_result in so the history
// validates. Stored messages are never mutated.
function repairDanglingToolUse(messages: ApiMessage[]): ApiMessage[] {
  const out = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }));
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const ids = m.content.filter((b: any) => b?.type === 'tool_use').map((b: any) => String(b.id));
    if (ids.length === 0) continue;
    const next = out[i + 1];
    const satisfied = new Set<string>();
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const b of next.content as any[]) if (b?.type === 'tool_result') satisfied.add(b.tool_use_id);
    }
    const missing = ids.filter((id) => !satisfied.has(id));
    if (missing.length === 0) continue;
    const synthetic: ContentBlock[] = missing.map((id) => ({
      type: 'tool_result', tool_use_id: id, content: '(no result recorded — the turn was interrupted)', is_error: true,
    }));
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      next.content = [...synthetic, ...next.content];
    } else {
      out.splice(i + 1, 0, { role: 'user', content: synthetic });
    }
  }
  return out;
}

// Render a web_search_tool_result for chat UIs: one "title — url" line per
// hit. Mirrored in the sidepanel's history reconstruction.
function formatWebSearchResult(content: unknown): string {
  if (Array.isArray(content)) {
    const lines = content
      .filter((r: any) => r?.type === 'web_search_result')
      .map((r: any) => `${r.title ?? '(untitled)'} — ${r.url ?? ''}`);
    return lines.length ? lines.join('\n') : '(no results)';
  }
  const code = (content as any)?.error_code;
  return code ? `search failed: ${code}` : '(no results)';
}

// Re-mark the cache breakpoint on the final content block of the final
// message. Returns shallow copies — stored messages are never mutated.
// Assistant-final histories (pause_turn continuations) are left unmarked:
// their last block can be a thinking/server-tool block, which rejects
// cache_control.
function withCacheBreakpoint(messages: ApiMessage[]): ApiMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.content) || last.content.length === 0) return messages;
  const blocks = last.content.slice();
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } } as any;
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

// Native messaging caps daemon→Chrome messages at 1MB, so history responses
// must not carry base64 image data. Chat UIs re-derive screenshot previews
// from /api/shots URLs in tool output; stripped blocks keep their type so a
// "(image)" chip can still render.
export function stripImagesForTransport(messages: ApiMessage[]): ApiMessage[] {
  const stripBlock = (b: any): any => {
    if (b?.type === 'image') return { type: 'image', source: { type: 'stripped' } };
    // Web search results carry bulky encrypted_content the UI never reads —
    // drop it (JSON serialization removes the undefined) to stay under the cap.
    if (b?.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      return { ...b, content: b.content.map((r: any) => (r?.type === 'web_search_result' ? { ...r, encrypted_content: undefined } : r)) };
    }
    return b;
  };
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((b: any) => {
        if (b?.type === 'tool_result' && Array.isArray(b.content)) {
          return { ...b, content: b.content.map(stripBlock) };
        }
        return stripBlock(b);
      }),
    };
  });
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private env: AgentEnv, private sink: EventSink) {}

  // Find-or-create only — no events, no run. The caller registers its event
  // routing for the returned session FIRST, then calls run(); otherwise the
  // session_started event races the routing table and gets dropped.
  prepare(identity: AgentIdentity, sessionId?: string): Session {
    let session = sessionId ? this.get(sessionId) : null;
    if (!session) {
      const id = sessionId ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      session = new Session(id, this.env, this.sink);
      this.sessions.set(id, session);
    }
    session.identity = identity;
    return session;
  }

  run(session: Session, text: string, images?: UserImage[]): void {
    this.sink(session.id, { type: 'session_started', sessionId: session.id, title: session.meta.title });
    void session.sendMessage(text, images);
  }

  get(id: string): Session | null {
    const live = this.sessions.get(id);
    if (live) return live;
    const loaded = Session.load(id, this.env, this.sink);
    if (loaded) this.sessions.set(id, loaded);
    return loaded;
  }

  list(): SessionMeta[] {
    const metas: SessionMeta[] = [];
    try {
      for (const f of readdirSync(SESSIONS_DIR)) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -6);
        const session = this.get(id);
        if (session) metas.push(session.meta);
      }
    } catch {}
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
