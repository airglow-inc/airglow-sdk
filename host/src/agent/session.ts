// Agent sessions — the harness loop. One Session per conversation; the
// SessionManager owns them and is the daemon's entry point for agent traffic.
//
// Persistence: one JSONL file per session under state/sessions/. Lines are
// {type:'meta'} (latest wins) and {type:'message'} (Anthropic-format message,
// replayed in order on resume).

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

export interface AgentEnv {
  workspace: string;
  daemonOrigin: () => string;
  daemonLogPath: string;
  // Directory containing an `airglow` executable (PATH injection for bash).
  airglowBinDir: string;
  // Existing apps: id + workspace-relative directory (for the prompt).
  listApps: () => Promise<{ id: string; dir: string }[]>;
}

export class Session {
  readonly id: string;
  meta: SessionMeta;
  private messages: ApiMessage[] = [];
  running = false;
  identity: AgentIdentity = { userId: null, email: null };
  private abort: AbortController | null = null;

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

  static load(id: string, env: AgentEnv, sink: EventSink): Session | null {
    const s = new Session(id, env, sink);
    if (!existsSync(s.filePath)) return null;
    try {
      for (const line of readFileSync(s.filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        if (rec.type === 'meta') s.meta = rec.meta;
        else if (rec.type === 'message') s.messages.push(rec.message);
        else if (rec.type === 'message-append') {
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

  async sendMessage(text: string, images?: UserImage[]): Promise<void> {
    if (this.running) {
      this.emit({ type: 'error', message: 'agent is still working — wait for the turn to finish' });
      return;
    }
    this.running = true;
    this.abort = new AbortController();
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
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(...blocks);
        this.persist({ type: 'message-append', blocks });
      } else {
        const userMessage: ApiMessage = { role: 'user', content: blocks };
        this.messages.push(userMessage);
        this.persist({ type: 'message', message: userMessage });
      }
      await this.runLoop();
    } catch (e: any) {
      if (this.abort?.signal.aborted) {
        this.emit({ type: 'turn_done', stopReason: 'stopped' });
      } else {
        this.emit({ type: 'error', message: String(e?.message ?? e), ...(e?.code ? { code: e.code } : {}), ...(e?.resetHours ? { resetHours: e.resetHours } : {}) });
        this.emit({ type: 'turn_done', stopReason: 'error' });
      }
    } finally {
      this.running = false;
      this.abort = null;
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
        apps: await this.env.listApps().catch(() => []),
      });

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
      );

      if (i === 0) console.log(`[agent ${this.id}] model: ${completed.model ?? '(unknown)'}`);

      const assistantMessage: ApiMessage = { role: 'assistant', content: completed.content };
      this.messages.push(assistantMessage);
      this.persist({ type: 'message', message: assistantMessage });

      // Long server-tool turns (web search) pause mid-message; resending the
      // history as-is (ending with the assistant message) resumes the turn.
      if (completed.stopReason === 'pause_turn') continue;

      const toolUses = completed.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (completed.stopReason !== 'tool_use' || toolUses.length === 0) {
        this.emit({ type: 'turn_done', stopReason: completed.stopReason });
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
      const resultMessage: ApiMessage = { role: 'user', content: results };
      this.messages.push(resultMessage);
      this.persist({ type: 'message', message: resultMessage });
      signal.throwIfAborted();
    }
    this.emit({ type: 'error', message: `stopped after ${MAX_LOOP_ITERATIONS} tool iterations` });
    this.emit({ type: 'turn_done', stopReason: 'max_iterations' });
  }
}

// Tool output as shown in chat UIs (tool_end events). The model sees the full
// content; this only bounds the UI payload (native messaging caps at 1MB).
const SUMMARY_CHARS = 5000;
function truncateSummary(text: string): string {
  if (text.length <= SUMMARY_CHARS) return text;
  return text.slice(0, SUMMARY_CHARS) + `\n…(truncated, ${text.length - SUMMARY_CHARS} more chars)`;
}

// Drop empty text blocks before sending — the API rejects them ("text content
// blocks must be non-empty"). Adaptive thinking can emit a text block that
// never receives deltas, and such a block, once persisted, poisons every
// later request. Messages left with no content are dropped entirely. Stored
// messages are never mutated.
function sanitizeForApi(messages: ApiMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      if (typeof m.content === 'string' && !m.content.trim()) continue;
      out.push(m);
      continue;
    }
    const content = m.content.filter((b: any) => !(b?.type === 'text' && !String(b.text ?? '').trim()));
    if (content.length === 0) continue;
    out.push({ ...m, content });
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
