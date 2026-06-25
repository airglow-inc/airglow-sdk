// Agent event protocol — what the daemon streams to chat clients (the
// sidepanel via connector, or any WS client speaking the connector protocol).

export type AgentEvent =
  | { type: 'session_started'; sessionId: string; title: string | null }
  | { type: 'text_delta'; text: string }
  // Reasoning started for this step. Content stays hidden; chat UIs show a
  // "Thinking" indicator until the next text/tool event.
  | { type: 'thinking' }
  | { type: 'tool_start'; toolId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_end'; toolId: string; name: string; ok: boolean; summary: string }
  | { type: 'plan'; items: { text: string; done: boolean }[] }
  | { type: 'task'; title: string }
  | { type: 'app_context'; appId: string; name: string }
  // startedAt is the turn's wall-clock start (ms) — the authoritative source for
  // the client's "Worked for X" duration, so it survives a panel that lost its
  // own start ref (reopen / resync / SW recycle mid-turn).
  // errorStatus/errorCode are set only when stopReason==='error': the HTTP
  // status (0 = daemon could not reach the gateway at all) and a coarse failure
  // code, so chat clients can report which kind of failure a turn hit.
  | { type: 'turn_done'; stopReason: string; startedAt?: number | null; errorStatus?: number; errorCode?: string }
  // A user message injected mid-turn (a follow-up sent while the agent was
  // working). Carries no image bytes (1MB transport cap) — imageCount drives
  // placeholder chips; clientId lets the originating panel skip its own
  // optimistic echo. Lives in the event buffer so a resync replays it.
  | { type: 'user_message'; text: string; imageCount?: number; clientId?: string }
  // A queued follow-up has been folded into the conversation (drainPending) and
  // is no longer waiting — chat clients drop the "in queue" pill on the matching
  // bubbles. clientIds are the follow-ups' optimistic-send ids. Buffered like
  // user_message so a resync replays the queued→injected transition.
  | { type: 'followup_injected'; clientIds: string[] }
  // A transient connection failure is being retried (network drop, upstream
  // 5xx/429, or a stalled model stream). `attempt` is the 1-based retry index.
  // Chat UIs show a "reconnecting" indicator until the next stream event lands;
  // a retry that ultimately fails ends as a normal `error` + turn_done.
  | { type: 'reconnecting'; attempt: number }
  | { type: 'error'; message: string; code?: string; resetHours?: number };

export interface SessionMeta {
  id: string;
  title: string | null;
  appId: string | null;
  appName: string | null;
  createdAt: number;
  updatedAt: number;
}

// Anthropic Messages API content blocks (the subset we use).
export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | ImageBlock
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | (ImageBlock | { type: 'text'; text: string })[]; is_error?: boolean }
  // Server tools (web_search): executed by the Anthropic API inside the
  // assistant turn. Both blocks live in assistant messages and must be
  // persisted verbatim — later turns need them for citations.
  | { type: 'server_tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'web_search_tool_result'; tool_use_id: string; content: unknown };

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[] | string;
}
