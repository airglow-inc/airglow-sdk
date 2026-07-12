/**
 * Handles messages from the airglow SDK (userscripts, UI, startup).
 * Provides storage, fetch, logging, RPC proxying, and platform capabilities.
 */

import type { AppSource, SourcedManifest } from './app-loader';
import { logger } from './logger';
import { ensureIdentity } from './airglow-identity';
import { getStoredSession } from './airglow-auth';

const STORAGE_PREFIX = 'airglow:app:';
const DEFAULT_POPUP_WIDTH = 520;
const DEFAULT_POPUP_HEIGHT = 720;
const APP_MANIFESTS_KEY = '__app_manifests';
const REMOTE_RPC_TIMEOUT_MS = 30000;
const REMOTE_RPC_RETRY_DELAYS_MS = [500, 1500];
const LLM_TIMEOUT_MS = 60000;
// Plugin-assisted calls (e.g. OpenRouter's web plugin) run search round-trips
// before the model answers, so they need a longer client timeout than a plain
// completion.
const LLM_PLUGIN_TIMEOUT_MS = 120000;
const LLM_RETRY_DELAYS_MS = [500, 1500];
// Streaming LLM calls: sendResponse is one-shot, so the SDK polls for buffered
// SSE events instead. A stream nobody polls for LLM_STREAM_GC_MS is an app
// context that died (tab closed, iframe unmounted) — abort upstream and drop
// it. The byte cap bounds a between-polls burst (a whole message is well under
// 1 MB; 4 MB means the consumer stopped draining).
const LLM_STREAM_GC_MS = 30000;
const LLM_STREAM_SWEEP_MS = 15000;
const LLM_STREAM_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

// Remove every storage key under an app's namespace. Called on app uninstall
// (daemon → background) so uninstalled apps leave no data behind; a later
// reinstall of the same id starts clean.
export async function clearAppStorage(appId: string): Promise<{ removed: number }> {
  const prefix = `${STORAGE_PREFIX}${appId}:`;
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
  if (keys.length) await chrome.storage.local.remove(keys);
  return { removed: keys.length };
}

async function getAirglowRpcIdentity(): Promise<{ email?: string; userId: string; authToken?: string }> {
  const [identity, session] = await Promise.all([ensureIdentity(), getStoredSession()]);
  return session
    ? { userId: session.userId, email: session.email ?? identity.email, authToken: session.token }
    : identity;
}

// Legacy x-airglow-* headers ride along during the migration so older
// backends keep working; the Bearer token wins server-side when present.
function buildIdentityHeaders(identity: { email?: string; userId: string; authToken?: string }): Record<string, string> {
  return {
    'X-Airglow-User-Id': identity.userId,
    ...(identity.email ? { 'X-Airglow-User-Email': identity.email } : {}),
    ...(identity.authToken ? { Authorization: `Bearer ${identity.authToken}` } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

type RemoteRpcError = Error & {
  code?: string;
  status?: number;
  requestId?: string;
  details?: unknown;
};

// Error bodies come in two shapes: the daemon's flat `{ error, code }` and
// the cloud's nested `{ error: { code, message, requestId } }`.
function parseErrorEnvelope(res: Response, result: unknown, fallbackMessage: string, fallbackCode: string): RemoteRpcError {
  const envelope = result && typeof result === 'object' ? result as Record<string, any> : {};
  const nestedError = envelope.error && typeof envelope.error === 'object'
    ? envelope.error as Record<string, any>
    : undefined;
  const message =
    (nestedError && typeof nestedError.message === 'string' ? nestedError.message : undefined) ||
    (typeof envelope.error === 'string' ? envelope.error : undefined) ||
    fallbackMessage;
  const error = new Error(message) as RemoteRpcError;
  error.code =
    (nestedError && typeof nestedError.code === 'string' ? nestedError.code : undefined) ||
    (typeof envelope.code === 'string' ? envelope.code : undefined) ||
    fallbackCode;
  error.status = res.status;
  error.requestId =
    (nestedError && typeof nestedError.requestId === 'string' ? nestedError.requestId : undefined) ||
    (typeof envelope.requestId === 'string' ? envelope.requestId : undefined) ||
    res.headers.get('x-request-id') ||
    undefined;
  error.details = result;
  return error;
}

function toRemoteRpcError(functionName: string, res: Response, result: unknown): RemoteRpcError {
  return parseErrorEnvelope(res, result, `RPC '${functionName}' failed with HTTP ${res.status}`, 'RPC_HTTP_ERROR');
}

function toRemoteRpcNetworkError(functionName: string, error: unknown): RemoteRpcError {
  if (error instanceof Error && (error as RemoteRpcError).code) return error as RemoteRpcError;
  const message = error instanceof Error ? error.message : String(error);
  const next = new Error(`RPC '${functionName}' network request failed: ${message}`) as RemoteRpcError;
  next.code = 'RPC_NETWORK_ERROR';
  next.details = error instanceof Error ? { name: error.name, message: error.message } : error;
  return next;
}

/**
 * Server execution: POST payload to the source's RPC endpoint with identity
 * headers. Retries transient HTTP failures + AbortError.
 */
async function executeRemoteRpc(
  appId: string,
  source: AppSource,
  functionName: string,
  payload: unknown,
): Promise<unknown> {
  const identity = await getAirglowRpcIdentity();
  const baseUrl = source.url.replace(/\/+$/, '');
  const url = `${baseUrl}/api/apps/${encodeURIComponent(appId)}/rpc/${encodeURIComponent(functionName)}`;
  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildIdentityHeaders(identity),
    },
    body: JSON.stringify(payload),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= REMOTE_RPC_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetchWithTimeout(url, requestInit, REMOTE_RPC_TIMEOUT_MS);
      const text = await res.text();
      let result;
      try { result = JSON.parse(text); } catch { result = text; }
      if (!res.ok) {
        const error = toRemoteRpcError(functionName, res, result);
        lastError = error;
        if (shouldRetryHttpStatus(res.status) && attempt < REMOTE_RPC_RETRY_DELAYS_MS.length) {
          await sleep(REMOTE_RPC_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw error;
      }
      return result;
    } catch (error) {
      lastError = error;
      const rawStatus = (error as RemoteRpcError)?.status;
      const status = typeof rawStatus === 'number' ? rawStatus : null;
      if (status !== null && !shouldRetryHttpStatus(status)) {
        throw error;
      }
      if (attempt < REMOTE_RPC_RETRY_DELAYS_MS.length) {
        await sleep(REMOTE_RPC_RETRY_DELAYS_MS[attempt]);
        continue;
      }
    }
  }
  throw toRemoteRpcNetworkError(functionName, lastError);
}

/**
 * Fetch via page context: injects a content script into a tab on the target domain.
 * Gives correct cookies (SameSite), Sec-Fetch-* headers, and origin — indistinguishable from a real page request.
 */
async function fetchViaPage(
  url: string, method?: string, headers?: Record<string, string>, body?: string,
): Promise<{ status: number; body: any }> {
  const targetUrl = new URL(url);
  const targetOrigin = targetUrl.origin;

  const tabs = await chrome.tabs.query({ url: `${targetUrl.protocol}//${targetUrl.hostname}/*` });
  let tabId: number;
  let createdTab = false;

  if (tabs.length > 0) {
    tabId = tabs[0].id!;
  } else {
    const tab = await chrome.tabs.create({ url: targetOrigin, active: false });
    tabId = tab.id!;
    createdTab = true;
    await new Promise<void>((resolve) => {
      const listener = (id: number, info: any) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (fetchUrl: string, fetchMethod: string, fetchHeaders: Record<string, string>, fetchBody: string | null) => {
        try {
          const res = await fetch(fetchUrl, {
            method: fetchMethod,
            headers: fetchHeaders || undefined,
            body: fetchBody || undefined,
            credentials: 'include',
          });
          const text = await res.text();
          return { status: res.status, body: text };
        } catch (e: any) {
          return { status: 0, body: 'fetchViaPage error: ' + e.message };
        }
      },
      args: [url, method || 'GET', headers || {}, body || null],
    });

    const result = results?.[0]?.result as { status: number; body: string } | undefined;
    if (!result) throw new Error('No result from page fetch');

    let parsed;
    try { parsed = JSON.parse(result.body); } catch { parsed = result.body; }
    return { status: result.status, body: parsed };
  } finally {
    if (createdTab) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

// ── Connectors (third-party tools via the daemon's Composio service) ──

const CONNECTOR_TIMEOUT_MS = 90000;
const CONNECT_FLOW_DEADLINE_MS = 180000;

async function connectorsPost(appId: string, action: string, payload: Record<string, unknown>): Promise<any> {
  const source = appSourceMap.get(appId);
  if (!source) {
    const e = new Error(`No source registered for app '${appId}'. Is the Airglow daemon running?`) as RemoteRpcError;
    e.code = 'CONNECTOR_SOURCE_NOT_REGISTERED';
    throw e;
  }
  const url = `${source.url.replace(/\/+$/, '')}/api/connectors/${action}`;
  // Identity rides along so the daemon's gateway mode forwards THIS user's
  // session token instead of falling back to the last announced identity.
  const identity = await getAirglowRpcIdentity();
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildIdentityHeaders(identity) },
    body: JSON.stringify({ appId, ...payload }),
  }, CONNECTOR_TIMEOUT_MS);
  const text = await res.text();
  let result;
  try { result = JSON.parse(text); } catch { result = text; }
  if (!res.ok) throw parseErrorEnvelope(res, result, `connectors ${action} failed with HTTP ${res.status}`, 'CONNECTOR_HTTP_ERROR');
  return result;
}

function connectorErrorResponse(e: unknown): Record<string, unknown> {
  const err = e as RemoteRpcError;
  return {
    error: err instanceof Error ? err.message : String(err),
    code: err?.code || 'CONNECTOR_NETWORK_ERROR',
    status: err?.status,
    details: err?.details,
  };
}

// Composio's hosted link flow (connect.composio.dev/link/…) builds the Google
// OAuth request client-side and drops any login_hint, so multi-account users
// land on Google's account chooser. When the popup reaches a Google OAuth URL
// without a hint, re-issue the SAME authorization request (client_id, scope,
// state, PKCE challenge unchanged — Composio's callback can't tell the
// difference) with login_hint added; Google then skips the chooser for that
// account. Any URL-shape mismatch returns null → no rewrite, chooser as today.
const OAUTH_HINT_PARAMS = [
  'access_type', 'client_id', 'code_challenge', 'code_challenge_method',
  'prompt', 'redirect_uri', 'response_type', 'scope', 'state',
];

function hintedAuthUrl(rawUrl: string, email: string): string | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const q = url.searchParams;
  // The auth request and the chooser it redirects to both carry the full
  // OAuth param set; consent/sign-in pages don't — requiring these keeps the
  // rewrite off every other Google page the popup passes through.
  if (url.hostname !== 'accounts.google.com' || q.has('login_hint')) return null;
  if (!q.get('client_id') || !q.get('state') || !q.get('redirect_uri') || !q.get('scope')) return null;
  const params = new URLSearchParams();
  for (const key of OAUTH_HINT_PARAMS) {
    const value = q.get(key);
    if (value != null) params.set(key, value);
  }
  params.set('login_hint', email);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Full connect flow: ask the daemon for an OAuth URL, open it in a centered
// popup, poll the daemon until the connection turns ACTIVE, close the popup.
// Closing the popup early cancels (after one final status check — Composio's
// success page is sometimes closed by quick users before we poll).
async function runConnectFlow(appId: string, toolkit: string, account: unknown): Promise<{ connected: boolean }> {
  const init = await connectorsPost(appId, 'initiate', { toolkit, account });
  if (init.connected) return { connected: true };

  const win = await chrome.windows.create({
    url: init.authUrl,
    type: 'popup',
    width: DEFAULT_POPUP_WIDTH,
    height: DEFAULT_POPUP_HEIGHT,
  });
  const winId = win?.id;
  let popupClosed = false;
  const onRemoved = (removedId: number) => {
    if (removedId === winId) popupClosed = true;
  };
  chrome.windows.onRemoved.addListener(onRemoved);

  // Email-shaped account label → preselect that account (see hintedAuthUrl).
  // One rewrite per popup: the hinted URL carries login_hint, so the matcher
  // can't re-fire, but the flag also guards against a user backing out to an
  // unhinted URL and getting yanked forward again.
  const popupTabId = win?.tabs?.[0]?.id;
  const hintEmail = typeof account === 'string' && account.includes('@') ? account : null;
  let hinted = false;
  const onUpdated = (tabId: number, info: any) => {
    if (hinted || tabId !== popupTabId || !info.url || !hintEmail) return;
    const next = hintedAuthUrl(info.url, hintEmail);
    if (!next) return;
    hinted = true;
    chrome.tabs.update(tabId, { url: next }, () => void chrome.runtime.lastError);
  };
  if (hintEmail && popupTabId != null) chrome.tabs.onUpdated.addListener(onUpdated);

  try {
    const deadline = Date.now() + CONNECT_FLOW_DEADLINE_MS;
    while (Date.now() < deadline) {
      const w = await connectorsPost(appId, 'wait', {
        connectedAccountId: init.connectedAccountId,
        timeoutMs: popupClosed ? 2000 : 5000,
      });
      if (w.connected) return { connected: true };
      if (['FAILED', 'EXPIRED', 'REVOKED'].includes(w.status)) {
        const e = new Error(`connection ${String(w.status).toLowerCase()}`) as RemoteRpcError;
        e.code = 'CONNECTOR_AUTH_FAILED';
        throw e;
      }
      if (popupClosed) {
        const e = new Error('User closed the auth window') as RemoteRpcError;
        e.code = 'CONNECTOR_AUTH_CANCELLED';
        throw e;
      }
    }
    const e = new Error('Timed out waiting for the connection to be approved') as RemoteRpcError;
    e.code = 'CONNECTOR_AUTH_TIMEOUT';
    throw e;
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.windows.onRemoved.removeListener(onRemoved);
    if (winId != null && !popupClosed) chrome.windows.remove(winId, () => void chrome.runtime.lastError);
  }
}

let appManifests: SourcedManifest[] = [];
const appSourceMap = new Map<string, AppSource>();

export function setAppManifests(manifests: SourcedManifest[]): void {
  appManifests = manifests;
  appSourceMap.clear();
  for (const m of manifests) {
    appSourceMap.set(m.id, m._source);
  }
}

export function getAppManifests(): SourcedManifest[] {
  return appManifests;
}

/**
 * MV3 SW death race: the SW gets killed when idle. When it wakes up to handle
 * a message, in-memory `appManifests` is empty and every dispatch fails with
 * "unknown appId". Re-hydrate from chrome.storage on cache miss.
 */
async function hydrateAppManifestsFromStorage(): Promise<void> {
  if (appManifests.length > 0) return;
  try {
    const result = await chrome.storage.local.get(APP_MANIFESTS_KEY);
    const cached = result[APP_MANIFESTS_KEY];
    if (Array.isArray(cached) && cached.length > 0) {
      setAppManifests(cached as SourcedManifest[]);
    }
  } catch (error) {
    logger.warn('airglow', `cached manifest hydration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type OnAppLog = (appId: string, level: 'info' | 'warn' | 'error', sender: chrome.runtime.MessageSender) => void;
let _onAppLog: OnAppLog | undefined;
export function setOnAppLog(cb: OnAppLog): void { _onAppLog = cb; }

// Open an app inside the dashboard. The background owns the extension id
// (chrome.runtime.getURL), so apps/userscripts/the edge button never hardcode
// it — the single id-agnostic way to open the single-shell app view or a
// focused app popup (e.g. an app's chat window). Exported so background.ts can
// serve the edge-button popup's plain `airglow:open-app` message, which carries
// no `_airglow` flag and so never reaches dispatchAirglowMessage.
export function openAppInDashboard(
  msg: { appId?: unknown; page?: unknown; window?: unknown; width?: number; height?: number },
  sendResponse: (response: any) => void,
): boolean {
  const appId = typeof msg.appId === 'string' ? msg.appId : '';
  if (!appId) { sendResponse({ ok: false, error: 'missing appId' }); return true; }
  const page = typeof msg.page === 'string' && msg.page ? msg.page : '';
  let url = chrome.runtime.getURL(`dashboard.html?app=${encodeURIComponent(appId)}`);
  if (page) url += `&appPage=${encodeURIComponent(page)}`;
  if (msg.window === true) {
    // Focused popup: render just the app frame (chromeless), centered.
    url += '&chromeless=1';
    const w = msg.width || DEFAULT_POPUP_WIDTH, h = msg.height || DEFAULT_POPUP_HEIGHT;
    chrome.windows.getCurrent((parent) => {
      const left = (parent.left ?? 0) + Math.round(((parent.width ?? 1200) - w) / 2);
      const top = (parent.top ?? 0) + Math.round(((parent.height ?? 800) - h) / 2);
      chrome.windows.create({ url, type: 'popup', width: w, height: h, left, top }, () => {
        sendResponse(chrome.runtime.lastError
          ? { ok: false, error: chrome.runtime.lastError.message }
          : { ok: true });
      });
    });
    return true;
  }
  // Default: reuse the single dashboard tab (navigate + focus) so it feels
  // like one SaaS site; otherwise open a fresh one.
  const dashPrefix = chrome.runtime.getURL('dashboard.html');
  chrome.tabs.query({}, (tabs) => {
    const existing = tabs.find((t) => t.url && t.url.startsWith(dashPrefix));
    if (existing?.id != null) {
      chrome.tabs.update(existing.id, { url, active: true });
      if (existing.windowId != null) chrome.windows.update(existing.windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
    sendResponse({ ok: true });
  });
  return true;
}

function normalizeHttpMethod(value: unknown): string {
  return (typeof value === 'string' && value.trim() ? value.trim() : 'GET').toUpperCase().slice(0, 20);
}

// ── Streaming LLM calls (airglow.llm.chat with onEvent) ──
//
// The background owns the upstream SSE connection; app contexts can't hold a
// live channel to us (sendResponse is one-shot on every bridge), so events
// accumulate here per streamId and the SDK drains them by polling. The final
// resolve value is assembled here once — not in every app context.

type LlmStreamError = { error: string; code?: string; status?: number; requestId?: string; details?: unknown };

type LlmStreamRecord = {
  appId: string;
  events: unknown[];
  bufferedBytes: number;
  done: boolean;
  result?: unknown;
  error?: LlmStreamError;
  lastPollAt: number;
  abort: () => void;
};

const llmStreams = new Map<string, LlmStreamRecord>();
let llmStreamSweeper: ReturnType<typeof setInterval> | null = null;

function sweepLlmStreams(): void {
  const now = Date.now();
  for (const [id, record] of llmStreams) {
    if (now - record.lastPollAt > LLM_STREAM_GC_MS) {
      record.abort();
      llmStreams.delete(id);
    }
  }
  if (llmStreams.size === 0 && llmStreamSweeper) {
    clearInterval(llmStreamSweeper);
    llmStreamSweeper = null;
  }
}

function ensureLlmStreamSweeper(): void {
  if (!llmStreamSweeper) llmStreamSweeper = setInterval(sweepLlmStreams, LLM_STREAM_SWEEP_MS);
}

/**
 * Rebuilds the complete chat.completion object from OpenAI-style stream
 * chunks, so the streaming path resolves with the same shape as the buffered
 * path. tool_calls[].function.arguments stream as string fragments — they
 * concatenate here and stay a JSON string, exactly as in a buffered response.
 */
function createLlmMessageAssembler() {
  let completion: any = null;
  return {
    apply(evt: any): void {
      if (!evt || typeof evt !== 'object' || !Array.isArray(evt.choices)) return;
      if (!completion) {
        completion = { id: evt.id, object: 'chat.completion', created: evt.created, model: evt.model, choices: [] };
      }
      // Usage rides the final chunk (the gateway forces usage.include).
      if (evt.usage) completion.usage = evt.usage;
      for (const c of evt.choices) {
        const idx = typeof c?.index === 'number' ? c.index : 0;
        let choice = completion.choices[idx];
        if (!choice) {
          choice = completion.choices[idx] = { index: idx, message: { role: 'assistant', content: null }, finish_reason: null };
        }
        if (c.finish_reason) choice.finish_reason = c.finish_reason;
        const d = c.delta;
        if (!d || typeof d !== 'object') continue;
        if (typeof d.role === 'string' && d.role) choice.message.role = d.role;
        if (typeof d.content === 'string') choice.message.content = (choice.message.content ?? '') + d.content;
        if (typeof d.reasoning === 'string') choice.message.reasoning = (choice.message.reasoning ?? '') + d.reasoning;
        // Web-plugin citations arrive as annotation deltas.
        if (Array.isArray(d.annotations)) {
          choice.message.annotations = (choice.message.annotations || []).concat(d.annotations);
        }
        if (Array.isArray(d.tool_calls)) {
          const calls = (choice.message.tool_calls = choice.message.tool_calls || []);
          for (const tc of d.tool_calls) {
            if (!tc || typeof tc !== 'object') continue;
            const ti = typeof tc.index === 'number' ? tc.index : 0;
            let call = calls[ti];
            if (!call) call = calls[ti] = { id: undefined, type: 'function', function: { name: '', arguments: '' } };
            if (typeof tc.id === 'string' && tc.id) call.id = tc.id;
            if (typeof tc.type === 'string' && tc.type) call.type = tc.type;
            if (typeof tc.function?.name === 'string') call.function.name += tc.function.name;
            if (typeof tc.function?.arguments === 'string') call.function.arguments += tc.function.arguments;
          }
        }
      }
    },
    message(): unknown {
      return completion;
    },
  };
}

function startLlmStream(
  appId: string,
  url: string,
  payload: unknown,
  idleTimeoutMs: number,
  sendResponse: (response: any) => void,
): void {
  sweepLlmStreams();
  ensureLlmStreamSweeper();
  const streamId = crypto.randomUUID();
  const record: LlmStreamRecord = {
    appId,
    events: [],
    bufferedBytes: 0,
    done: false,
    lastPollAt: Date.now(),
    abort: () => {},
  };
  llmStreams.set(streamId, record);
  sendResponse({ streamId });

  const fail = (e: unknown) => {
    const err = e as RemoteRpcError;
    record.error = {
      error: err instanceof Error ? err.message : String(err),
      code: err?.code || 'LLM_NETWORK_ERROR',
      status: err?.status,
      requestId: err?.requestId,
      details: err?.details,
    };
  };

  (async () => {
    const identity = await getAirglowRpcIdentity();
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Airglow-App-Id': appId,
        ...buildIdentityHeaders(identity),
      },
      body: JSON.stringify({ ...(payload as Record<string, unknown>), stream: true }),
    };

    // Connect, retrying like the buffered path — safe because a non-ok
    // response never streamed anything. Once the SSE body is open, never
    // retry: events already reached the app.
    let res: Response | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt <= LLM_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const r = await fetchWithTimeout(url, requestInit, idleTimeoutMs);
        if (!r.ok) {
          const text = await r.text();
          let result;
          try { result = JSON.parse(text); } catch { result = text; }
          const error = parseErrorEnvelope(r, result, `LLM request failed with HTTP ${r.status}`, 'LLM_HTTP_ERROR');
          lastError = error;
          if (error.code === 'LLM_BUDGET_EXCEEDED') break;
          if (shouldRetryHttpStatus(r.status) && attempt < LLM_RETRY_DELAYS_MS.length) {
            await sleep(LLM_RETRY_DELAYS_MS[attempt]);
            continue;
          }
          break;
        }
        res = r;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < LLM_RETRY_DELAYS_MS.length) {
          await sleep(LLM_RETRY_DELAYS_MS[attempt]);
          continue;
        }
      }
    }
    if (!res?.body) {
      fail(lastError ?? new Error('LLM stream request failed'));
      return;
    }

    // Read SSE. The whole-request deadline doesn't apply to a stream — an
    // idle timeout does: no bytes for idleTimeoutMs means the upstream is
    // half-open (see the daemon's stream-idle history), so cut it.
    const reader = res.body.getReader();
    record.abort = () => { void reader.cancel().catch(() => {}); };
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => record.abort(), idleTimeoutMs);
    };
    const assembler = createLlmMessageAssembler();
    let sawDone = false;
    const decoder = new TextDecoder();
    let buf = '';
    try {
      armIdle();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          // OpenAI SSE framing, not an event — the clean-end marker.
          if (data === '[DONE]') { sawDone = true; continue; }
          let evt: any;
          try { evt = JSON.parse(data); } catch { continue; }
          // Mid-stream provider error (or the gateway's upstream_truncated
          // marker) — standalone {error} objects, not chunks.
          if (evt?.error && !Array.isArray(evt.choices)) {
            const streamError = new Error(evt.error?.message || 'LLM stream error') as RemoteRpcError;
            streamError.code = 'LLM_STREAM_ERROR';
            streamError.details = evt.error;
            throw streamError;
          }
          assembler.apply(evt);
          record.events.push(evt);
          record.bufferedBytes += line.length;
          if (record.bufferedBytes > LLM_STREAM_MAX_BUFFER_BYTES) {
            const overflow = new Error('LLM stream buffer overflow (consumer stopped polling?)') as RemoteRpcError;
            overflow.code = 'LLM_STREAM_OVERFLOW';
            throw overflow;
          }
        }
      }
    } catch (e) {
      fail(e);
      record.abort();
      return;
    } finally {
      clearTimeout(idleTimer);
    }
    if (!sawDone) {
      record.error = { error: 'the model stream ended before completing', code: 'LLM_STREAM_TRUNCATED' };
      return;
    }
    record.result = assembler.message();
    record.done = true;
  })().catch(fail);
}

export function handleAirglowMessage(
  msg: any,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
): boolean {
  if (!msg?._airglow) return false;

  // Dashboard/app-management types are handled by background.ts's own
  // onMessage branches; return false so bridged calls from app UIs fall
  // through to them instead of dying here with UNKNOWN_MESSAGE_TYPE. They
  // need no per-app validation — they don't touch app-scoped state.
  // NB: 'airglow:open-app' is NOT here. SDK-bridge calls carry `_airglow` and
  // must be served by the `case 'airglow:open-app'` in dispatchAirglowMessage
  // below (reached for both the userscript and app_ui paths) — listing it here
  // would return false and let it fall to background.ts, skipping the per-app
  // appId validation. (background.ts has a separate plain-message branch that
  // shares openAppInDashboard, for the edge-button popup which sends no
  // `_airglow` flag.)
  const BRIDGE_PASSTHROUGH_TYPES = new Set([
    'airglow:get-dashboard-manifests',
    'airglow:open-dashboard',
  ]);
  if (BRIDGE_PASSTHROUGH_TYPES.has(msg?.type)) return false;

  const appId = msg._appId;
  if (!appId) {
    sendResponse({ error: 'missing _appId' });
    return true;
  }

  // Validate appId: if sender is an extension page with ?app= param,
  // the claimed appId must match. Prevents iframe from spoofing appId.
  if (_sender.url) {
    try {
      const senderUrl = new URL(_sender.url);
      const senderAppId = senderUrl.searchParams.get('app');
      if (senderAppId && senderAppId !== appId) {
        sendResponse({ error: `appId mismatch: claimed ${appId}, sender has ${senderAppId}` });
        return true;
      }
    } catch {}
  }

  const continueWithKnownApp = () => {
    if (!appManifests.some((m) => m.id === appId)) {
      sendResponse({ error: `unknown appId: ${appId}` });
      return;
    }

    const senderWorldId = (_sender as any).userScriptWorldId as string | undefined;
    if (senderWorldId) {
      const expectedWorldId = `airglow:${appId}`;
      if (senderWorldId !== expectedWorldId) {
        sendResponse({ error: `appId mismatch: claimed ${appId}, world is ${senderWorldId}` });
        return;
      }
    }

    const storageKey = (key: string) => `${STORAGE_PREFIX}${appId}:${key}`;
    const handled = dispatchAirglowMessage(msg, appId, storageKey, _sender, sendResponse);
    if (!handled) sendResponse({ error: `unknown message type: ${msg.type}`, code: 'UNKNOWN_MESSAGE_TYPE' });
  };

  if (!appManifests.some((m) => m.id === appId)) {
    hydrateAppManifestsFromStorage()
      .then(continueWithKnownApp)
      .catch((error) => {
        logger.warn('airglow', `cached manifest hydration failed: ${error instanceof Error ? error.message : String(error)}`);
        sendResponse({ error: `unknown appId: ${appId}` });
      });
    return true;
  }

  continueWithKnownApp();
  return true;
}

function dispatchAirglowMessage(
  msg: any,
  appId: string,
  storageKey: (key: string) => string,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
): boolean {

  try {
  switch (msg.type) {
    case 'airglow:storage:get': {
      chrome.storage.local.get(storageKey(msg.key), (result) => {
        sendResponse({ value: result[storageKey(msg.key)] });
      });
      return true;
    }

    case 'airglow:storage:set':
      chrome.storage.local.set({ [storageKey(msg.key)]: msg.value }, () => {
        sendResponse({ ok: true });
      });
      return true;

    case 'airglow:storage:delete':
      chrome.storage.local.remove(storageKey(msg.key), () => {
        sendResponse({ ok: true });
      });
      return true;

    case 'airglow:storage:list': {
      const prefix = `${STORAGE_PREFIX}${appId}:`;
      chrome.storage.local.get(null, (all) => {
        const keys = Object.keys(all)
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length));
        sendResponse({ keys });
      });
      return true;
    }

    case 'airglow:fetch': {
      const httpMethod = normalizeHttpMethod(msg.method);
      try {
        new URL(String(msg.url || ''));
      } catch {
        sendResponse({ error: 'invalid fetch URL', code: 'INVALID_FETCH_URL' });
        return true;
      }
      if (msg.includeCookies) {
        fetchViaPage(msg.url, msg.method, msg.headers, msg.body)
          .then((result) => {
            sendResponse(result);
          })
          .catch((e) => {
            sendResponse({ error: e.message });
          });
      } else {
        const fetchOpts: RequestInit = {
          method: httpMethod,
          headers: msg.headers,
          body: msg.body,
        };
        fetch(msg.url, fetchOpts)
          .then(async (res) => {
            const text = await res.text();
            let body;
            try { body = JSON.parse(text); } catch { body = text; }
            sendResponse({ status: res.status, body });
          })
          .catch((e) => {
            sendResponse({ error: e.message });
          });
      }
      return true;
    }

    case 'airglow:cookie:get': {
      const cookieUrl = String(msg.url || '');
      const cookieName = String(msg.name || '');
      try {
        new URL(cookieUrl);
      } catch {
        sendResponse({ error: 'invalid cookie URL', code: 'INVALID_COOKIE_URL' });
        return true;
      }
      if (!cookieName) {
        sendResponse({ error: 'cookie name is required', code: 'INVALID_COOKIE_NAME' });
        return true;
      }
      chrome.cookies.get({ url: cookieUrl, name: cookieName }, (cookie) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message, code: 'COOKIE_READ_FAILED' });
          return;
        }
        sendResponse({ value: cookie ? cookie.value : null });
      });
      return true;
    }

    case 'airglow:log': {
      const level = msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'info';
      const text = msg.data ? `${msg.message} ${typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)}` : msg.message;
      logger[level](appId, text, msg.stack);
      _onAppLog?.(appId, level, _sender);
      sendResponse({ ok: true });
      return true;
    }

    case 'airglow:rpc': {
      const functionName = String(msg.functionName || '');
      const source = appSourceMap.get(appId);
      if (!source) {
        logger.warn('airglow', `RPC failed: no source registered for app '${appId}'`);
        sendResponse({
          error: `No source registered for app '${appId}'. Is an app source reachable?`,
          code: 'RPC_SOURCE_NOT_REGISTERED',
        });
        return true;
      }
      // Server-eval on the daemon that owns this app. No client-side execution.
      executeRemoteRpc(appId, source, functionName, msg.payload)
        .then((result) => {
          sendResponse({ result });
        })
        .catch((e) => {
          sendResponse({
            error: e instanceof Error ? e.message : String(e),
            code: (e as any)?.code || 'RPC_NETWORK_ERROR',
            status: (e as any)?.status,
            requestId: (e as any)?.requestId,
            details: (e as any)?.details,
          });
        });
      return true;
    }

    case 'airglow:llm:chat': {
      const source = appSourceMap.get(appId);
      if (!source) {
        sendResponse({
          error: `No source registered for app '${appId}'. Is an app source reachable?`,
          code: 'LLM_SOURCE_NOT_REGISTERED',
        });
        return true;
      }
      const baseUrl = source.url.replace(/\/+$/, '');
      const url = `${baseUrl}/api/llm/v1/chat/completions`;
      const llmPayload = msg.payload as { plugins?: unknown; tools?: unknown } | undefined;
      // Web tooling (web plugin or openrouter:web_search / web_fetch server
      // tools) runs search round-trips inside the request — longer deadline.
      const usesWebTooling = (Array.isArray(llmPayload?.plugins) && llmPayload.plugins.length > 0)
        || (Array.isArray(llmPayload?.tools) && llmPayload.tools.some((t: any) =>
          typeof t?.type === 'string'
          && (t.type.startsWith('openrouter:') || t.type.startsWith('web_search_') || t.type.startsWith('web_fetch_'))));
      const llmTimeoutMs = usesWebTooling ? LLM_PLUGIN_TIMEOUT_MS : LLM_TIMEOUT_MS;
      if (msg.stream === true) {
        startLlmStream(appId, url, msg.payload, llmTimeoutMs, sendResponse);
        return true;
      }
      (async () => {
        const identity = await getAirglowRpcIdentity();
        const requestInit: RequestInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Airglow-App-Id': appId,
            ...buildIdentityHeaders(identity),
          },
          body: JSON.stringify(msg.payload),
        };

        let lastError: unknown;
        for (let attempt = 0; attempt <= LLM_RETRY_DELAYS_MS.length; attempt++) {
          try {
            const res = await fetchWithTimeout(url, requestInit, llmTimeoutMs);
            const text = await res.text();
            let result;
            try { result = JSON.parse(text); } catch { result = text; }
            if (!res.ok) {
              const error = parseErrorEnvelope(res, result, `LLM request failed with HTTP ${res.status}`, 'LLM_HTTP_ERROR');
              lastError = error;
              // Weekly budget exhaustion is terminal for the window — don't
              // retry the same wall (each retry records another block).
              if (error.code === 'LLM_BUDGET_EXCEEDED') break;
              if (shouldRetryHttpStatus(res.status) && attempt < LLM_RETRY_DELAYS_MS.length) {
                await sleep(LLM_RETRY_DELAYS_MS[attempt]);
                continue;
              }
              break;
            }
            sendResponse({ result });
            return;
          } catch (error) {
            lastError = error;
            const status = typeof (error as any)?.status === 'number' ? (error as any).status : null;
            if (status !== null && !shouldRetryHttpStatus(status)) break;
            if (attempt < LLM_RETRY_DELAYS_MS.length) {
              await sleep(LLM_RETRY_DELAYS_MS[attempt]);
              continue;
            }
          }
        }
        const err = lastError as any;
        sendResponse({
          error: err instanceof Error ? err.message : String(err),
          code: err?.code || 'LLM_NETWORK_ERROR',
          status: err?.status,
          requestId: err?.requestId,
          details: err?.details,
        });
      })().catch((e) => {
        sendResponse({ error: e?.message || String(e), code: 'LLM_NETWORK_ERROR' });
      });
      return true;
    }

    case 'airglow:llm:stream:poll': {
      const streamId = String(msg.streamId || '');
      const record = llmStreams.get(streamId);
      if (!record || record.appId !== appId) {
        // Also hit after an MV3 SW restart wiped the map — the SDK rejects
        // instead of polling a void forever.
        sendResponse({ error: 'unknown or expired streamId', code: 'LLM_STREAM_NOT_FOUND' });
        return true;
      }
      record.lastPollAt = Date.now();
      const events = record.events;
      record.events = [];
      record.bufferedBytes = 0;
      if (record.done) {
        llmStreams.delete(streamId);
        sendResponse({ events, done: true, result: record.result });
      } else if (record.error && events.length === 0) {
        // Deliver buffered events before surfacing the error (next poll).
        llmStreams.delete(streamId);
        sendResponse(record.error);
      } else {
        sendResponse({ events, done: false });
      }
      return true;
    }

    case 'airglow:connectors:connect': {
      runConnectFlow(appId, String(msg.toolkit ?? ''), msg.account)
        .then(sendResponse)
        .catch((e) => sendResponse(connectorErrorResponse(e)));
      return true;
    }

    case 'airglow:connectors:status':
    case 'airglow:connectors:disconnect': {
      const action = msg.type === 'airglow:connectors:status' ? 'status' : 'disconnect';
      connectorsPost(appId, action, { toolkit: msg.toolkit, account: msg.account })
        .then(sendResponse)
        .catch((e) => sendResponse(connectorErrorResponse(e)));
      return true;
    }

    case 'airglow:connectors:execute': {
      connectorsPost(appId, 'execute', { tool: msg.tool, arguments: msg.arguments, account: msg.account })
        .then(sendResponse)
        .catch((e) => sendResponse(connectorErrorResponse(e)));
      return true;
    }

    case 'airglow:identity:getRedirectURL': {
      sendResponse({ url: chrome.identity.getRedirectURL() });
      return true;
    }

    case 'airglow:identity:launchWebAuthFlow': {
      const redirectBase = chrome.identity.getRedirectURL();
      const aw = msg.width || DEFAULT_POPUP_WIDTH, ah = msg.height || DEFAULT_POPUP_HEIGHT;
      chrome.windows.getCurrent((parent) => {
        const left = (parent.left ?? 0) + Math.round(((parent.width ?? 1200) - aw) / 2);
        const top = (parent.top ?? 0) + Math.round(((parent.height ?? 800) - ah) / 2);
        chrome.windows.create({ url: msg.url, type: 'popup', width: aw, height: ah, left, top }, (win) => {
          const winId = win?.id;
          const tabId = win?.tabs?.[0]?.id;
          if (winId == null) { sendResponse({ error: 'no window created' }); return; }

          const onNav = (details: { tabId: number; frameId: number; url: string }) => {
            if (details.tabId !== tabId || details.frameId !== 0) return;
            if (details.url.startsWith(redirectBase)) {
              chrome.webNavigation.onBeforeNavigate.removeListener(onNav);
              chrome.windows.onRemoved.removeListener(onClose);
              chrome.windows.remove(winId, () => {});
              sendResponse({ redirectUrl: details.url });
            }
          };
          const onClose = (removedId: number) => {
            if (removedId !== winId) return;
            chrome.webNavigation.onBeforeNavigate.removeListener(onNav);
            chrome.windows.onRemoved.removeListener(onClose);
            sendResponse({ error: 'User closed the auth window' });
          };
          chrome.webNavigation.onBeforeNavigate.addListener(onNav);
          chrome.windows.onRemoved.addListener(onClose);
        });
      });
      return true;
    }

    case 'airglow:openWindow': {
      const w = msg.width || DEFAULT_POPUP_WIDTH, h = msg.height || DEFAULT_POPUP_HEIGHT;
      chrome.windows.getCurrent((parent) => {
        const left = msg.left ?? ((parent.left ?? 0) + Math.round(((parent.width ?? 1200) - w) / 2));
        const top = msg.top ?? ((parent.top ?? 0) + Math.round(((parent.height ?? 800) - h) / 2));
        const type = msg.popup !== false ? 'popup' : 'normal';
        chrome.windows.create({ url: msg.url, type, width: w, height: h, left, top }, (win) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          const winId = win?.id;
          if (winId == null) {
            sendResponse({ ok: false, error: 'no window created' });
            return;
          }
          if (!msg.waitClose) {
            sendResponse({ ok: true, windowId: winId });
            return;
          }
          const onRemoved = (removedId: number) => {
            if (removedId !== winId) return;
            chrome.windows.onRemoved.removeListener(onRemoved);
            sendResponse({ ok: true });
          };
          chrome.windows.onRemoved.addListener(onRemoved);
        });
      });
      return true;
    }

    case 'airglow:openTab': {
      chrome.tabs.create({ url: msg.url, active: msg.active !== false }, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, tabId: tab?.id });
      });
      return true;
    }

    case 'airglow:open-app':
      return openAppInDashboard(msg, sendResponse);

    case 'airglow:captureTab': {
      const tabId = _sender.tab?.id;
      if (tabId == null) {
        sendResponse({ error: 'no sender tab' });
        return true;
      }
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab.windowId) {
          sendResponse({ error: 'cannot get tab window' });
          return;
        }
        chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
          }
          const base64 = dataUrl.split(',')[1];
          sendResponse({ base64, mediaType: 'image/jpeg' });
        });
      });
      return true;
    }

    case 'airglow:platform:allowIframes': {
      const IFRAME_KEY = '__platform:iframeAllow';
      chrome.storage.local.get(IFRAME_KEY, (result) => {
        const all: Record<string, any> = result[IFRAME_KEY] as Record<string, any> || {};
        all[appId] = { domains: msg.domains || [], initiators: msg.initiators || [] };
        chrome.storage.local.set({ [IFRAME_KEY]: all }, () => {
          logger.info(appId, `stored ${(msg.domains || []).length} iframe-allow domain(s)`);
          sendResponse({ ok: true });
        });
      });
      return true;
    }

    default:
      return false;
  }
  } catch (e) {
    logger.error(appId, `handler error for ${msg.type}: ${e instanceof Error ? e.message : String(e)}`, e instanceof Error ? e.stack : undefined);
    sendResponse({ error: `handler error: ${e instanceof Error ? e.message : String(e)}` });
    return true;
  }
}
