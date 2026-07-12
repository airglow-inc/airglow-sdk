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
// Total attempts per request (1 initial + 1 retry). One retry recovers the
// common transient death (sleep/wake, a brief blip); beyond that a stream is
// usually genuinely dead, so we surface the error fast rather than make the user
// wait out more rounds. Worst-case dead-stream error ≈ MAX_RETRIES × idle window
// (~40s in gateway mode) instead of dragging to a minute-plus.
const MAX_RETRIES = 2;
// Inactivity ceiling for the SSE read: total silence this long means the socket
// is half-open (see consumeStream). Sized to the mode's guaranteed cadence:
//   - Gateway mode injects a 15s SSE heartbeat (agent-gateway withIdleHeartbeat),
//     so a healthy stream is NEVER silent >~15s. 20s catches a dead connection
//     fast (the user isn't left staring at a frozen turn) without false-tripping.
//   - Direct-Anthropic dev has no heartbeat, so a long quiet gap (first token on
//     a big context, a pause between blocks) is legitimate — allow more slack.
// Read at call time so the env override applies regardless of import order (tests
// drive it to ms; ops can tune without a rebuild).
const GATEWAY_IDLE_TIMEOUT_MS = 20_000;
const DIRECT_IDLE_TIMEOUT_MS = 60_000;
function streamIdleTimeoutMs(): number {
  const override = Number(process.env.AIRGLOW_STREAM_IDLE_MS);
  if (override > 0) return override;
  return process.env.ANTHROPIC_API_KEY ? DIRECT_IDLE_TIMEOUT_MS : GATEWAY_IDLE_TIMEOUT_MS;
}

export function agentModel(): string {
  return DEFAULT_MODEL;
}

export function gatewayUrl(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return null; // dev: direct Anthropic
  return llmGatewayUrl();
}

// The gateway URL unconditionally. The app-LLM proxy (daemon/llm.ts) routes on
// OPENROUTER_API_KEY (BYOK), not on the agent's dev key — an agent running
// direct-Anthropic must not silently reroute app llm calls.
export function llmGatewayUrl(): string {
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
  // Called once if the gateway rejects the session token (401
  // AUTH_SESSION_INVALID). Resolves to a freshly-minted token (the chat client
  // re-authed) or null. A non-null result swaps the Bearer and retries the
  // request, so a stale token self-heals without surfacing an error.
  refreshAuth?: () => Promise<string | null>,
  // Called when a transient failure (network drop, upstream 5xx/429, or a
  // mid-stream socket stall) forces a re-issue of the request, with the 1-based
  // retry index. Lets the caller surface a "reconnecting" indicator instead of
  // a silent multi-second gap that reads like the model is still thinking. Not
  // fired for the silent auth-refresh retry (that path doesn't consume an attempt).
  onRetry?: (attempt: number) => void,
): Promise<CompletedMessage> {
  const { url, headers } = endpoint();
  // Gateway auth is the Bearer session token only — legacy user-id/-email
  // headers are no longer read server-side.
  if (identity.authToken) headers['authorization'] = `Bearer ${identity.authToken}`;
  headers['x-airglow-app-id'] = 'airglow-agent';

  // `session_id` is an Airglow gateway extension for conversation capture;
  // Anthropic rejects unknown top-level fields, so drop it in direct dev mode.
  const outgoing: Record<string, unknown> = { ...payload, stream: true };
  if (process.env.ANTHROPIC_API_KEY) delete outgoing.session_id;
  const body = JSON.stringify(outgoing);

  let lastError = '';
  // Last HTTP status seen across retries (0 = never reached the gateway). Fed
  // to the thrown error so the session can report the failure kind to clients.
  let lastStatus = 0;
  // One silent re-auth per call: guards against looping when the fresh token is
  // also rejected (wrong account, server still can't verify).
  let authRefreshed = false;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) { onRetry?.(attempt); await Bun.sleep(1000 * 2 ** attempt); }
    signal?.throwIfAborted();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal,
      });
    } catch (e: any) {
      if (signal?.aborted) throw e;
      lastStatus = 0;
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
        err.status = 429;
        err.code = 'AGENT_BUDGET_EXCEEDED';
        if (resetHours) err.resetHours = resetHours;
        throw err;
      }
      lastStatus = 429;
      lastError = 'upstream 429';
      continue;
    }
    if (res.status >= 500) {
      if (res.status === 503) {
        // Server-side kill switch (AIRGLOW_AGENT_GATEWAY_ENABLED=0): a
        // deliberate off state, not an outage — don't retry into it.
        const body = await res.text().catch(() => '');
        let code = '';
        try { code = JSON.parse(body)?.error?.code ?? ''; } catch {}
        if (code === 'AGENT_GATEWAY_DISABLED') {
          const err: any = new Error('The Airglow assistant is switched off on the server right now. Your installed apps keep working as usual.');
          err.status = 503;
          err.code = 'AGENT_GATEWAY_DISABLED';
          throw err;
        }
      }
      lastStatus = res.status;
      lastError = `upstream ${res.status}`;
      continue;
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      let code = '';
      try { code = JSON.parse(body)?.error?.code ?? ''; } catch {}
      // Stale/invalidated session token (expiry, secret rotation, or the dev
      // switching the gateway between prod and local). Ask the chat client to
      // silently re-mint and retry once with the fresh token — no user-visible
      // error when Google is still signed in.
      if (res.status === 401 && code === 'AUTH_SESSION_INVALID' && refreshAuth && !authRefreshed) {
        authRefreshed = true;
        const newToken = await refreshAuth().catch(() => null);
        if (newToken) {
          headers['authorization'] = `Bearer ${newToken}`;
          attempt--; // the refresh round-trip must not consume a retry
          continue;
        }
      }
      const err: any = new Error(`model API error ${res.status}: ${body.slice(0, 500)}`);
      err.status = res.status;
      if (code) err.code = code;
      throw err;
    }
    try {
      return await consumeStream(res.body, handlers, signal);
    } catch (e: any) {
      if (signal?.aborted) throw e;
      // The socket dropped (or the upstream truncated) mid-stream. If nothing
      // has streamed to the UI yet, the request is idempotent and safe to
      // re-issue — the user sees only a slightly longer "thinking". Once text is
      // on screen a silent retry would duplicate it, so surface the error.
      if (e?.streamCut && !e.producedOutput) {
        lastStatus = 0;
        lastError = `stream cut: ${e.cause?.message ?? e.message}`;
        continue;
      }
      throw e;
    }
  }
  const cut = lastError.startsWith('stream cut');
  const err: any = new Error(
    cut
      ? `The connection to the model kept dropping after ${MAX_RETRIES} attempts. Send your message again to continue.`
      : `model API unreachable after ${MAX_RETRIES} attempts (${lastError})`,
  );
  err.status = lastStatus;
  err.code = cut ? 'stream_cut' : lastStatus === 0 ? 'network' : `upstream_${lastStatus}`;
  throw err;
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<CompletedMessage> {
  const content: any[] = [];
  let stopReason = 'end_turn';
  let model: string | null = null;
  // Whether anything user-visible has streamed yet (live text, or a server-tool
  // call/result the UI surfaces). Reasoning ("thinking") shows only as a generic
  // indicator, so it doesn't count. Drives whether a mid-stream drop can be
  // retried invisibly: with no visible output yet, re-issuing the (idempotent)
  // request is seamless; once text is on screen a silent retry would duplicate it.
  let producedOutput = false;
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
  // Inactivity guard: a silently half-open socket (laptop network change, a
  // proxy/LB dropping the connection without a FIN) leaves reader.read() pending
  // forever — the turn then hangs with no tokens, no error, and chat UIs stuck on
  // "Thinking". If no bytes arrive for the idle window, cancel the reader and
  // reject; the catch below tags it streamCut so streamMessage retries
  // (seamlessly when nothing has streamed yet) or surfaces a legible error.
  const idleMs = streamIdleTimeoutMs();
  const readChunk = (): ReturnType<typeof reader.read> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new Error(`model stream idle for ${idleMs / 1000}s`));
      }, idleMs);
      reader.read().then(
        (r) => { clearTimeout(timer); resolve(r); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  try {
  while (true) {
    const { done, value } = await readChunk();
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
            producedOutput = true;
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
          if (closed?.type === 'server_tool_use') { producedOutput = true; handlers.onServerToolUse?.(closed.id, closed.name, closed.input); }
          else if (closed?.type === 'web_search_tool_result') { producedOutput = true; handlers.onServerToolResult?.(closed.tool_use_id, closed.content); }
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
  // Stream ended — if that was an abort (reader cancelled), surface it as a
  // stop rather than returning a truncated message.
  signal?.throwIfAborted();
  return { content: content.filter(Boolean), stopReason, model };
  } catch (e: any) {
    // User abort wins: surface as a stop, never a retryable failure.
    if (signal?.aborted) signal.throwIfAborted();
    // A mid-stream socket drop (Bun: "The socket connection was closed
    // unexpectedly…") or an `error` event the gateway/Anthropic injected when
    // the upstream cut mid-message. Both are transient. Re-tag with a tracked,
    // user-legible message and let streamMessage decide: retry seamlessly when
    // nothing has streamed yet, otherwise surface this.
    const err: any = new Error(
      producedOutput
        ? 'The connection to the model dropped mid-response. Send your message again to continue.'
        : 'the connection to the model dropped before it responded',
    );
    err.streamCut = true;
    err.producedOutput = producedOutput;
    err.code = 'stream_cut';
    err.cause = e;
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
