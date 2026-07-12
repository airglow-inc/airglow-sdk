// App-facing LLM proxy (airglow.llm.chat — OpenAI chat-completions schema).
// The extension routes airglow.llm calls to whichever source owns the app, so
// locally-served apps land here; the daemon forwards to the cloud LLM gateway,
// which owns auth, rate limits, and the shared weekly usage budget. With
// OPENROUTER_API_KEY set (~/.airglow/state/agent.env) calls go straight to
// OpenRouter on that key instead — BYOK: no gateway, no shared budget, no
// model allowlist.

import { llmGatewayUrl, type AgentIdentity } from '../agent/api';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
// BYOK calls skip the gateway's normalization, so fill its defaults here;
// everything else passes through for OpenRouter to validate.
const BYOK_DEFAULT_MODEL = 'anthropic/claude-sonnet-5';
const BYOK_DEFAULT_MAX_TOKENS = 2000;
// Above the gateway's own 20s upstream timeout so its error wins, below the
// extension's 60s client timeout.
const TIMEOUT_MS = 30_000;
// Plugin round-trips (e.g. OpenRouter's web plugin searching before the model
// answers) are slow; allow the gateway (90s upstream) and direct calls to
// finish. Stays below the extension's plugin-call timeout (120s).
const PLUGIN_TIMEOUT_MS = 110_000;

// The gateway authenticates on the Bearer session token only; the app id is
// for attribution/rate-limit scoping.
const IDENTITY_HEADERS = ['x-airglow-app-id', 'authorization'];

export async function handleLlmChatCompletions(
  req: Request,
  fallbackIdentity?: AgentIdentity | null,
  // Called once if the gateway rejects the session token (401
  // AUTH_SESSION_INVALID). Resolves to a freshly-minted token (the originating
  // browser silently re-authed) or null. A non-null result swaps the Bearer and
  // retries, so a stale token self-heals instead of surfacing to the app —
  // mirrors the agent stream path (agent/api.ts).
  refreshAuth?: () => Promise<string | null>,
): Promise<[number, unknown] | Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [400, { error: 'LLM request body must be a JSON object', code: 'LLM_INVALID_JSON' }];
  }
  const payload = body as Record<string, unknown>;
  // Web tooling (the web plugin, or server tools like openrouter:web_search)
  // adds search round-trips inside the request — allow the longer deadline.
  const wantsWebTooling = (Array.isArray(payload.plugins) && payload.plugins.length > 0)
    || (Array.isArray(payload.tools) && payload.tools.some((t: any) =>
      typeof t?.type === 'string'
      && (t.type.startsWith('openrouter:') || t.type.startsWith('web_search_') || t.type.startsWith('web_fetch_'))));
  const wantsStream = payload.stream === true;

  // BYOK wins over the gateway: the user opted out of the shared budget.
  const byok = process.env.OPENROUTER_API_KEY?.trim() || null;
  const gw = byok ? null : llmGatewayUrl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (gw) {
    // Gateway path: forward the payload untouched — the cloud gateway owns
    // validation, the model allowlist, and cost accounting.
    for (const name of IDENTITY_HEADERS) {
      const value = req.headers.get(name);
      if (value) headers[name] = value;
    }
    // Server-function airglow.llm calls loop back through the daemon with
    // only an app id — the user's auth token never enters the app
    // subprocess. Attach the last session token the extension announced.
    if (!headers['authorization'] && fallbackIdentity?.authToken) {
      headers['authorization'] = `Bearer ${fallbackIdentity.authToken}`;
    }
  } else {
    headers['authorization'] = `Bearer ${byok}`;
    if (typeof payload.model !== 'string' || !payload.model.trim()) payload.model = BYOK_DEFAULT_MODEL;
    if (typeof payload.max_tokens !== 'number') payload.max_tokens = BYOK_DEFAULT_MAX_TOKENS;
  }

  const url = gw ? `${gw}/api/llm/v1/chat/completions` : OPENROUTER_CHAT_URL;
  const timeoutMs = wantsWebTooling ? PLUGIN_TIMEOUT_MS : TIMEOUT_MS;
  if (wantsStream) return proxyLlmStream(url, headers, payload, timeoutMs, gw, refreshAuth);
  const send = () => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  try {
    let res = await send();
    let text = await res.text();
    // Gateway rejected this session's token (expiry, secret rotation, or the dev
    // switching gateway between prod and local). Ask the originating browser to
    // silently re-mint and retry once — no user-visible error while Google is
    // signed in. Only on the gateway path; BYOK has no session.
    if (gw && res.status === 401 && refreshAuth) {
      let code = '';
      try { code = (JSON.parse(text) as any)?.error?.code ?? ''; } catch {}
      if (code === 'AUTH_SESSION_INVALID') {
        const fresh = await refreshAuth().catch(() => null);
        if (fresh) {
          headers['authorization'] = `Bearer ${fresh}`;
          res = await send();
          text = await res.text();
        }
      }
    }
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 500), code: 'LLM_UPSTREAM_ERROR' }; }
    return [res.status, json];
  } catch (e: any) {
    return [502, { error: `LLM upstream unreachable: ${e?.message ?? e}`, code: 'LLM_UPSTREAM_ERROR' }];
  }
}

function parseLlmErrorBody(text: string): unknown {
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 500), code: 'LLM_UPSTREAM_ERROR' }; }
}

// Streaming variant: pipe the upstream SSE body through untouched. Error
// responses (non-2xx) never stream, so the 401 refresh dance still works —
// the token is rejected before any stream bytes exist. The whole-request
// deadline is replaced by (a) a headers timeout on connect and (b) an idle
// guard on the body: killing a healthy 60s+ plugin-assisted stream mid-flight
// is exactly what AbortSignal.timeout would do.
async function proxyLlmStream(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  timeoutMs: number,
  gw: string | null,
  refreshAuth?: () => Promise<string | null>,
): Promise<[number, unknown] | Response> {
  const connect = async () => {
    const controller = new AbortController();
    const headersTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return { res, controller };
    } finally {
      clearTimeout(headersTimer);
    }
  };

  try {
    let { res, controller } = await connect();
    if (gw && res.status === 401 && refreshAuth) {
      const text = await res.text();
      let code = '';
      try { code = (JSON.parse(text) as any)?.error?.code ?? ''; } catch {}
      if (code === 'AUTH_SESSION_INVALID') {
        const fresh = await refreshAuth().catch(() => null);
        if (fresh) {
          headers['authorization'] = `Bearer ${fresh}`;
          ({ res, controller } = await connect());
        } else {
          return [401, parseLlmErrorBody(text)];
        }
      } else {
        return [401, parseLlmErrorBody(text)];
      }
    }
    if (!res.ok || !res.body) {
      const text = await res.text();
      return [res.status, parseLlmErrorBody(text)];
    }

    const reader = res.body.getReader();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), timeoutMs);
    };
    const guarded = new ReadableStream<Uint8Array>({
      start() { armIdle(); },
      async pull(c) {
        try {
          const { done, value } = await reader.read();
          if (done) { clearTimeout(idleTimer); c.close(); return; }
          armIdle();
          c.enqueue(value);
        } catch (e) {
          clearTimeout(idleTimer);
          c.error(e);
        }
      },
      cancel(reason) {
        clearTimeout(idleTimer);
        void reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(guarded, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (e: any) {
    return [502, { error: `LLM upstream unreachable: ${e?.message ?? e}`, code: 'LLM_UPSTREAM_ERROR' }];
  }
}
