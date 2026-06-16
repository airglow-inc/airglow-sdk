// Streaming Messages API client. Two upstreams:
//   - the Airglow gateway (default): identity headers, billing/limits server-side
//   - api.anthropic.com directly when ANTHROPIC_API_KEY is set (development)

export interface AgentIdentity {
  userId: string | null;
  email: string | null;
  // Server-issued session JWT (Google sign-in). When present the gateway
  // trusts it over the legacy x-airglow-* headers.
  authToken?: string | null;
}

export interface StreamHandlers {
  onTextDelta: (text: string) => void;
  onToolUseStart: (toolId: string, name: string) => void;
  // A thinking block opened — reasoning content itself is never surfaced.
  onThinkingStart?: () => void;
  // A server tool call (web_search) — fired when its input finishes streaming.
  onServerToolUse?: (toolId: string, name: string, input: Record<string, unknown>) => void;
  // The matching server-side result block completed.
  onServerToolResult?: (toolUseId: string, content: unknown) => void;
}

export interface CompletedMessage {
  content: import('./types').ContentBlock[];
  stopReason: string;
  // Model id echoed by the server in message_start — ground truth, not config.
  model: string | null;
}

const DEFAULT_GATEWAY_URL = 'https://api.airglow.dev';
// Model and effort are deliberately hardcoded — not env-configurable. The
// product runs one model at one effort; changing them is a code change (and
// the gateway's allowlist enforces the model server-side anyway). `high`
// balances quality and cost for the builder agent.
const DEFAULT_MODEL = 'claude-opus-4-8';
export const AGENT_EFFORT = 'high';
const MAX_RETRIES = 3;

export function agentModel(): string {
  return DEFAULT_MODEL;
}

export function gatewayUrl(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return null; // dev: direct Anthropic
  return (process.env.AIRGLOW_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
}

// No beta headers needed: adaptive thinking interleaves thinking between
// tool calls natively (the old interleaved-thinking beta is obsolete).
function endpoint(): { url: string; headers: Record<string, string> } {
  const direct = process.env.ANTHROPIC_API_KEY;
  if (direct) {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': direct, 'anthropic-version': '2023-06-01' },
    };
  }
  return { url: `${gatewayUrl()}/api/agent/messages`, headers: {} };
}

export async function streamMessage(
  payload: Record<string, unknown>,
  identity: AgentIdentity,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<CompletedMessage> {
  const { url, headers } = endpoint();
  // Gateway auth is the Bearer session token only — legacy user-id/-email
  // headers are no longer read server-side.
  if (identity.authToken) headers['authorization'] = `Bearer ${identity.authToken}`;
  headers['x-airglow-app-id'] = 'airglow-agent';

  let lastError = '';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await Bun.sleep(1000 * 2 ** attempt);
    signal?.throwIfAborted();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ ...payload, stream: true }),
        signal,
      });
    } catch (e: any) {
      if (signal?.aborted) throw e;
      lastError = `network: ${e?.message ?? e}`;
      continue;
    }
    if (res.status === 429) {
      // Gateway budget exhaustion is terminal for the day — surface a plain
      // message instead of retrying into the same wall.
      const body = await res.text().catch(() => '');
      let code = '';
      try { code = JSON.parse(body)?.error?.code ?? ''; } catch {}
      if (code === 'AGENT_BUDGET_EXCEEDED') {
        const retryAfter = Number(res.headers.get('retry-after'));
        const resetHours = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.ceil(retryAfter / 3600)
          : undefined;
        const wait = resetHours ? `in about ${resetHours} hour${resetHours === 1 ? '' : 's'}` : 'tomorrow';
        const err: any = new Error(`You've reached this week's Airglow usage limit. Capacity starts freeing up ${wait} — your work is saved, come back then.`);
        err.code = 'AGENT_BUDGET_EXCEEDED';
        if (resetHours) err.resetHours = resetHours;
        throw err;
      }
      lastError = 'upstream 429';
      continue;
    }
    if (res.status >= 500) {
      lastError = `upstream ${res.status}`;
      continue;
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`model API error ${res.status}: ${body.slice(0, 500)}`);
    }
    return await consumeStream(res.body, handlers, signal);
  }
  throw new Error(`model API unreachable after ${MAX_RETRIES} attempts (${lastError})`);
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<CompletedMessage> {
  const content: any[] = [];
  let stopReason = 'end_turn';
  let model: string | null = null;
  // index → accumulated partial-JSON string for tool_use inputs
  const partialInputs = new Map<number, string>();

  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  // Abort mid-stream: cancelling the reader unblocks a pending read() even when
  // the model is idle between tokens, so `stop` interrupts within the turn
  // instead of waiting for the next loop-boundary check (or the stream's
  // natural end). Re-thrown below so the loop unwinds as a stop, not an answer.
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) { void reader.cancel().catch(() => {}); signal.throwIfAborted(); }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let evt: any;
      try { evt = JSON.parse(data); } catch { continue; }

      switch (evt.type) {
        case 'message_start': {
          if (typeof evt.message?.model === 'string') model = evt.message.model;
          // Cache effectiveness lands in the daemon log: healthy loops show
          // most input as "cache read" after the first iteration.
          const u = evt.message?.usage;
          if (u) {
            console.log(
              `[agent] usage: input ${u.input_tokens ?? 0}, cache write ${u.cache_creation_input_tokens ?? 0}, cache read ${u.cache_read_input_tokens ?? 0}`,
            );
          }
          break;
        }
        case 'content_block_start': {
          const block = evt.content_block;
          if (block.type === 'text') {
            content[evt.index] = { type: 'text', text: '' };
          } else if (block.type === 'thinking') {
            content[evt.index] = { type: 'thinking', thinking: '', signature: '' };
            handlers.onThinkingStart?.();
          } else if (block.type === 'redacted_thinking') {
            content[evt.index] = { type: 'redacted_thinking', data: block.data ?? '' };
          } else if (block.type === 'tool_use') {
            content[evt.index] = { type: 'tool_use', id: block.id, name: block.name, input: {} };
            partialInputs.set(evt.index, '');
            handlers.onToolUseStart(block.id, block.name);
          } else if (block.type === 'server_tool_use') {
            content[evt.index] = { type: 'server_tool_use', id: block.id, name: block.name, input: block.input ?? {} };
            partialInputs.set(evt.index, '');
          } else if (block.type === 'web_search_tool_result') {
            // Server tool results arrive complete in the start event.
            content[evt.index] = { type: 'web_search_tool_result', tool_use_id: block.tool_use_id, content: block.content };
          }
          break;
        }
        case 'content_block_delta': {
          const delta = evt.delta;
          if (delta.type === 'text_delta') {
            content[evt.index].text += delta.text;
            handlers.onTextDelta(delta.text);
          } else if (delta.type === 'thinking_delta') {
            content[evt.index].thinking += delta.thinking;
          } else if (delta.type === 'signature_delta') {
            content[evt.index].signature = delta.signature;
          } else if (delta.type === 'input_json_delta') {
            partialInputs.set(evt.index, (partialInputs.get(evt.index) ?? '') + delta.partial_json);
          }
          break;
        }
        case 'content_block_stop': {
          const partial = partialInputs.get(evt.index);
          if (partial !== undefined) {
            // Empty partial → keep the input from content_block_start (server
            // tools can deliver it there instead of via deltas).
            try { if (partial) content[evt.index].input = JSON.parse(partial); }
            catch { content[evt.index].input = {}; }
            partialInputs.delete(evt.index);
          }
          const closed = content[evt.index];
          if (closed?.type === 'server_tool_use') handlers.onServerToolUse?.(closed.id, closed.name, closed.input);
          else if (closed?.type === 'web_search_tool_result') handlers.onServerToolResult?.(closed.tool_use_id, closed.content);
          break;
        }
        case 'message_delta':
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
          break;
        case 'error':
          throw new Error(`stream error: ${evt.error?.message ?? JSON.stringify(evt.error)}`);
      }
    }
  }
  signal?.removeEventListener('abort', onAbort);
  // Stream ended — if that was an abort (reader cancelled), surface it as a
  // stop rather than returning a truncated message.
  signal?.throwIfAborted();
  return { content: content.filter(Boolean), stopReason, model };
}
