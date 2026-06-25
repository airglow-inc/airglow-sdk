// App-facing LLM proxy. The extension routes airglow.llm calls to whichever
// source owns the app, so locally-served apps land here; the daemon forwards
// to the cloud LLM gateway, which owns auth, rate limits, and the shared
// weekly usage budget. With ANTHROPIC_API_KEY set (dev) calls go straight to
// Anthropic instead — the same escape hatch the agent uses (agent/api.ts).

import { gatewayUrl, type AgentIdentity } from '../agent/api';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305';
const WEB_SEARCH_DEFAULT_MAX_USES = 5;
const WEB_SEARCH_DEV_DEFAULT_MAX_TOKENS = 4000;
// Direct-Anthropic dev calls skip the gateway's normalization, so fill its
// defaults here; everything else passes through for Anthropic to validate.
const DEV_DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEV_DEFAULT_MAX_TOKENS = 2000;
// Above the gateway's own 20s upstream timeout so its error wins, below the
// extension's 60s client timeout.
const TIMEOUT_MS = 30_000;
// Web search round-trips are slow; allow the gateway (45s upstream) and direct
// Anthropic calls to finish. Stays below the extension's web-search timeout.
const WEB_SEARCH_TIMEOUT_MS = 90_000;

// The gateway authenticates on the Bearer session token only; the app id is
// for attribution/rate-limit scoping. Legacy x-airglow-user-id/-email are no
// longer read server-side, so they aren't forwarded.
const IDENTITY_HEADERS = ['x-airglow-app-id', 'authorization'];

export async function handleLlmAnthropicMessages(req: Request, fallbackIdentity?: AgentIdentity | null): Promise<[number, unknown]> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [400, { error: 'LLM request body must be a JSON object', code: 'LLM_INVALID_JSON' }];
  }
  const payload = body as Record<string, unknown>;
  const wantsWebSearch = !!payload.web_search;

  const gw = gatewayUrl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (gw) {
    // Gateway path: forward web_search untouched — the cloud gateway owns the
    // web_search→tools translation, validation, and cost accounting.
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
    headers['x-api-key'] = process.env.ANTHROPIC_API_KEY!;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    if (typeof payload.model !== 'string' || !payload.model.trim()) payload.model = DEV_DEFAULT_MODEL;
    // Direct Anthropic doesn't know the gateway's web_search convenience param;
    // translate it to the real tool here so dev mode matches the gateway.
    if (wantsWebSearch && !payload.tools) {
      const ws = payload.web_search;
      const maxUses = ws && typeof ws === 'object' && typeof (ws as Record<string, unknown>).max_uses === 'number'
        ? (ws as Record<string, number>).max_uses
        : WEB_SEARCH_DEFAULT_MAX_USES;
      payload.tools = [{ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: maxUses }];
    }
    delete payload.web_search;
    if (typeof payload.max_tokens !== 'number') {
      payload.max_tokens = wantsWebSearch ? WEB_SEARCH_DEV_DEFAULT_MAX_TOKENS : DEV_DEFAULT_MAX_TOKENS;
    }
  }

  try {
    const res = await fetch(gw ? `${gw}/api/llm/anthropic/messages` : ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(wantsWebSearch ? WEB_SEARCH_TIMEOUT_MS : TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 500), code: 'LLM_UPSTREAM_ERROR' }; }
    return [res.status, json];
  } catch (e: any) {
    return [502, { error: `LLM upstream unreachable: ${e?.message ?? e}`, code: 'LLM_UPSTREAM_ERROR' }];
  }
}
