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
  | { type: 'app_context'; appId: string; name: string }
  | { type: 'approval_request'; approvalId: string; action: string; detail: string }
  | { type: 'approval_resolved'; approvalId: string; approved: boolean }
  // errorStatus/errorCode are set only when stopReason==='error': the HTTP
  // status (0 = daemon could not reach the gateway at all) and a coarse failure
  // code, so chat clients can report which kind of failure a turn hit.
  | { type: 'turn_done'; stopReason: string; errorStatus?: number; errorCode?: string }
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
