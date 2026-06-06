/**
 * Handles messages from the airglow SDK (userscripts, UI, startup).
 * Provides storage, fetch, logging, RPC proxying, and platform capabilities.
 */

import type { AppSource, SourcedManifest } from './app-loader';
import { logger } from './logger';
import { USER_EMAIL_KEY, normalizeUserEmail } from './airglow-identity';
import { trackAppUsed, type AnalyticsPropertyValue, type AppUseAction } from './analytics';

const STORAGE_PREFIX = 'airglow:app:';
const USER_SECRET_PREFIX = 'airglow:secret:';
const DEV_SECRET_PREFIX = 'airglow:dev-secret:';
const DEFAULT_POPUP_WIDTH = 520;
const DEFAULT_POPUP_HEIGHT = 720;
const AIRGLOW_USER_ID_KEY = '__airglow_user_id';
const APP_MANIFESTS_KEY = '__app_manifests';
const REMOTE_RPC_TIMEOUT_MS = 30000;
const REMOTE_RPC_RETRY_DELAYS_MS = [500, 1500];
const LLM_TIMEOUT_MS = 60000;
const LLM_RETRY_DELAYS_MS = [500, 1500];

async function getAirglowRpcIdentity(): Promise<{ email?: string; userId: string }> {
  const stored = await chrome.storage.local.get([USER_EMAIL_KEY, AIRGLOW_USER_ID_KEY]);
  let userId = typeof stored[AIRGLOW_USER_ID_KEY] === 'string' ? stored[AIRGLOW_USER_ID_KEY] : '';
  if (!userId) {
    userId = `ag_${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [AIRGLOW_USER_ID_KEY]: userId });
  }
  return {
    email: normalizeUserEmail(stored[USER_EMAIL_KEY]),
    userId,
  };
}

function buildIdentityHeaders(identity: { email?: string; userId: string }): Record<string, string> {
  return {
    'X-Airglow-User-Id': identity.userId,
    ...(identity.email ? { 'X-Airglow-User-Email': identity.email } : {}),
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

function toRemoteRpcError(functionName: string, res: Response, result: unknown): RemoteRpcError {
  const envelope = result && typeof result === 'object' ? result as Record<string, any> : {};
  const nestedError = envelope.error && typeof envelope.error === 'object'
    ? envelope.error as Record<string, any>
    : undefined;
  const message =
    (nestedError && typeof nestedError.message === 'string' ? nestedError.message : undefined) ||
    (typeof envelope.error === 'string' ? envelope.error : undefined) ||
    `RPC '${functionName}' failed with HTTP ${res.status}`;
  const error = new Error(message) as RemoteRpcError;
  error.code =
    (nestedError && typeof nestedError.code === 'string' ? nestedError.code : undefined) ||
    (typeof envelope.code === 'string' ? envelope.code : undefined) ||
    'RPC_HTTP_ERROR';
  error.status = res.status;
  error.requestId =
    (nestedError && typeof nestedError.requestId === 'string' ? nestedError.requestId : undefined) ||
    (typeof envelope.requestId === 'string' ? envelope.requestId : undefined) ||
    res.headers.get('x-request-id') ||
    undefined;
  error.details = result;
  return error;
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

function getManifest(appId: string): SourcedManifest | undefined {
  return appManifests.find((m) => m.id === appId);
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

function isClientSetting(appId: string, key: string): boolean {
  const manifest = getManifest(appId);
  if (!manifest?.secrets) return false;
  return key in (manifest.secrets as Record<string, any>);
}

function matchesPattern(pattern: string, url: string): boolean {
  try {
    const u = new URL(url);
    const m = pattern.match(/^(\*|https?|ftp):\/\/(\*|(?:\*\.)?[^/]*)\/(.*)$/);
    if (!m) return false;
    const [, scheme, host, path] = m;
    if (scheme !== '*' && scheme !== u.protocol.replace(':', '')) return false;
    if (host !== '*') {
      if (host.startsWith('*.')) {
        const domain = host.slice(2);
        if (u.hostname !== domain && !u.hostname.endsWith('.' + domain)) return false;
      } else if (u.hostname !== host) {
        return false;
      }
    }
    const pathRe = new RegExp('^/' + path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return pathRe.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

function isUrlAllowedForFetch(appId: string, url: string): boolean {
  const manifest = getManifest(appId);
  if (!manifest?.host_permissions?.length) return false;
  return manifest.host_permissions.some((p) => matchesPattern(p, url));
}

export type OnAppLog = (appId: string, level: 'info' | 'warn' | 'error', sender: chrome.runtime.MessageSender) => void;
let _onAppLog: OnAppLog | undefined;
export function setOnAppLog(cb: OnAppLog): void { _onAppLog = cb; }

type AppUsageExtra = Record<string, AnalyticsPropertyValue>;

const MAX_CUSTOM_ANALYTICS_PROPS = 20;
const CUSTOM_ANALYTICS_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

function senderSurface(sender: chrome.runtime.MessageSender): string {
  const senderWorldId = (sender as any).userScriptWorldId as string | undefined;
  if (senderWorldId) return 'userscript';
  const senderUrl = typeof sender.url === 'string' ? sender.url : '';
  try {
    const url = new URL(senderUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') return 'userscript';
  } catch {}
  if (senderUrl.includes('/app-shell.html')) return 'app_ui';
  if (senderUrl.includes('/startup-runner.html') || senderUrl.includes('/startup-sandbox.html')) return 'startup';
  return 'extension';
}

function trackUsage(
  appId: string,
  action: AppUseAction,
  sender: chrome.runtime.MessageSender,
  extra: AppUsageExtra = {},
) {
  const app = getManifest(appId);
  if (!app) return Promise.resolve();
  return trackAppUsed(app, action, { surface: senderSurface(sender), ...extra }).catch((e) => {
    logger.warn('airglow', `trackAppUsed failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}

function normalizeCustomUsageAction(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  if (!normalized || !/^[a-z]/.test(normalized)) return undefined;
  return normalized;
}

function normalizeCustomPropertyKey(key: string): string | undefined {
  const normalized = key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  if (!CUSTOM_ANALYTICS_KEY_RE.test(normalized)) return undefined;
  if (normalized === 'action' || normalized === 'app' || normalized === 'email' || normalized === 'user' || normalized === 'distinct_id') return undefined;
  if (normalized.startsWith('app_') || normalized.startsWith('user_') || normalized.startsWith('$')) return undefined;
  return normalized;
}

function normalizeCustomPropertyValue(value: unknown): AnalyticsPropertyValue | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === 'string').slice(0, 20);
    return strings.length > 0 ? strings : undefined;
  }
  return undefined;
}

function sanitizeCustomUsageProperties(value: unknown): Record<string, AnalyticsPropertyValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, AnalyticsPropertyValue> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_CUSTOM_ANALYTICS_PROPS)) {
    const key = normalizeCustomPropertyKey(rawKey);
    if (!key) continue;
    const propValue = normalizeCustomPropertyValue(rawValue);
    if (propValue === undefined) continue;
    out[`usage_${key}`] = propValue;
  }
  return out;
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code ? code : fallback;
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' ? status : null;
}

function normalizeHttpMethod(value: unknown): string {
  return (typeof value === 'string' && value.trim() ? value.trim() : 'GET').toUpperCase().slice(0, 20);
}

function usageResultForHttpStatus(status: number): 'success' | 'error' {
  return status >= 200 && status < 400 ? 'success' : 'error';
}

export function handleAirglowMessage(
  msg: any,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
): boolean {
  if (!msg?._airglow) return false;
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
    case 'airglow:analytics:used': {
      const usageAction = normalizeCustomUsageAction(msg.action);
      if (!usageAction) {
        sendResponse({ error: 'usage action must be a non-empty string starting with a letter', code: 'INVALID_USAGE_ACTION' });
        return true;
      }
      trackUsage(appId, 'app_action', _sender, {
        usage_action: usageAction,
        ...sanitizeCustomUsageProperties(msg.properties),
      }).then(() => {
        sendResponse({ ok: true });
      }).catch((error) => {
        logger.warn('airglow', `analytics used failed: ${error instanceof Error ? error.message : String(error)}`);
        sendResponse({ error: 'analytics used failed', code: 'ANALYTICS_USED_FAILED' });
      });
      return true;
    }

    case 'airglow:storage:get': {
      if (isClientSetting(appId, msg.key)) {
        const userKey = `${USER_SECRET_PREFIX}${msg.key}`;
        const devKey = `${DEV_SECRET_PREFIX}${msg.key}`;
        chrome.storage.local.get([userKey, devKey], (result) => {
          sendResponse({ value: result[userKey] ?? result[devKey] ?? undefined });
        });
      } else {
        chrome.storage.local.get(storageKey(msg.key), (result) => {
          sendResponse({ value: result[storageKey(msg.key)] });
        });
      }
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
      // host_permissions enforcement applies to ALL fetches (not just cookie
      // ones). Without this, a cloud app could exfiltrate to any URL via
      // the extension's privileged context (CORS-bypass, no SOP).
      const httpMethod = normalizeHttpMethod(msg.method);
      const fetchContext = msg.includeCookies ? 'page' : 'extension';
      let targetUrl: URL;
      try {
        targetUrl = new URL(String(msg.url || ''));
      } catch {
        trackUsage(appId, 'fetch', _sender, {
          result: 'error',
          error_code: 'INVALID_FETCH_URL',
          fetch_context: fetchContext,
          http_method: httpMethod,
        });
        sendResponse({ error: 'invalid fetch URL', code: 'INVALID_FETCH_URL' });
        return true;
      }
      if (!isUrlAllowedForFetch(appId, targetUrl.href)) {
        trackUsage(appId, 'fetch', _sender, {
          result: 'error',
          error_code: 'FETCH_HOST_PERMISSION_DENIED',
          fetch_context: fetchContext,
          http_method: httpMethod,
        });
        sendResponse({
          error: `app "${appId}" lacks host_permissions for ${targetUrl.hostname}`,
          code: 'FETCH_HOST_PERMISSION_DENIED',
        });
        return true;
      }
      if (msg.includeCookies) {
        fetchViaPage(msg.url, msg.method, msg.headers, msg.body)
          .then((result) => {
            trackUsage(appId, 'fetch', _sender, {
              result: usageResultForHttpStatus(result.status),
              fetch_context: fetchContext,
              http_method: httpMethod,
              http_status: result.status,
            });
            sendResponse(result);
          })
          .catch((e) => {
            trackUsage(appId, 'fetch', _sender, {
              result: 'error',
              error_code: errorCode(e, 'FETCH_NETWORK_ERROR'),
              fetch_context: fetchContext,
              http_method: httpMethod,
            });
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
            trackUsage(appId, 'fetch', _sender, {
              result: res.ok ? 'success' : 'error',
              fetch_context: fetchContext,
              http_method: httpMethod,
              http_status: res.status,
            });
            sendResponse({ status: res.status, body });
          })
          .catch((e) => {
            trackUsage(appId, 'fetch', _sender, {
              result: 'error',
              error_code: errorCode(e, 'FETCH_NETWORK_ERROR'),
              fetch_context: fetchContext,
              http_method: httpMethod,
            });
            sendResponse({ error: e.message });
          });
      }
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
        trackUsage(appId, 'rpc', _sender, {
          result: 'error',
          function_name: functionName,
          error_code: 'RPC_SOURCE_NOT_REGISTERED',
        });
        sendResponse({
          error: `No source registered for app '${appId}'. Is an app source reachable?`,
          code: 'RPC_SOURCE_NOT_REGISTERED',
        });
        return true;
      }
      // Server-eval against whichever source owns this app: local apps run on
      // the dev server, cloud apps run on the cloud. No client-side execution.
      executeRemoteRpc(appId, source, functionName, msg.payload)
        .then((result) => {
          trackUsage(appId, 'rpc', _sender, {
            result: 'success',
            function_name: functionName,
            execution: source.type === 'local' ? 'local_server' : 'cloud_server',
          });
          sendResponse({ result });
        })
        .catch((e) => {
          trackUsage(appId, 'rpc', _sender, {
            result: 'error',
            function_name: functionName,
            execution: source.type === 'local' ? 'local_server' : 'cloud_server',
            error_code: errorCode(e, 'RPC_NETWORK_ERROR'),
            http_status: errorStatus(e),
          });
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

    case 'airglow:llm:anthropic:messages': {
      const source = appSourceMap.get(appId);
      if (!source) {
        trackUsage(appId, 'llm', _sender, {
          result: 'error',
          provider: 'anthropic',
          error_code: 'LLM_SOURCE_NOT_REGISTERED',
        });
        sendResponse({
          error: `No source registered for app '${appId}'. Is an app source reachable?`,
          code: 'LLM_SOURCE_NOT_REGISTERED',
        });
        return true;
      }
      const baseUrl = source.url.replace(/\/+$/, '');
      const url = `${baseUrl}/api/llm/anthropic/messages`;
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
            const res = await fetchWithTimeout(url, requestInit, LLM_TIMEOUT_MS);
            const text = await res.text();
            let result;
            try { result = JSON.parse(text); } catch { result = text; }
            if (!res.ok) {
              const envelope = result && typeof result === 'object' ? result as Record<string, any> : {};
              const error = new Error(
                typeof envelope.error === 'string'
                  ? envelope.error
                  : `LLM request failed with HTTP ${res.status}`,
              ) as Error & { code?: string; status?: number; requestId?: string; details?: unknown };
              error.code = typeof envelope.code === 'string' ? envelope.code : 'LLM_HTTP_ERROR';
              error.status = res.status;
              error.requestId = typeof envelope.requestId === 'string' ? envelope.requestId : undefined;
              error.details = result;
              lastError = error;
              if (shouldRetryHttpStatus(res.status) && attempt < LLM_RETRY_DELAYS_MS.length) {
                await sleep(LLM_RETRY_DELAYS_MS[attempt]);
                continue;
              }
              throw error;
            }
            trackUsage(appId, 'llm', _sender, {
              result: 'success',
              provider: 'anthropic',
              execution: source.type === 'local' ? 'local_server' : 'cloud_server',
              http_status: res.status,
            });
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
        trackUsage(appId, 'llm', _sender, {
          result: 'error',
          provider: 'anthropic',
          execution: source.type === 'local' ? 'local_server' : 'cloud_server',
          error_code: errorCode(err, 'LLM_NETWORK_ERROR'),
          http_status: errorStatus(err),
        });
        sendResponse({
          error: err instanceof Error ? err.message : String(err),
          code: err?.code || 'LLM_NETWORK_ERROR',
          status: err?.status,
          requestId: err?.requestId,
          details: err?.details,
        });
      })().catch((e) => {
        trackUsage(appId, 'llm', _sender, {
          result: 'error',
          provider: 'anthropic',
          execution: source.type === 'local' ? 'local_server' : 'cloud_server',
          error_code: errorCode(e, 'LLM_NETWORK_ERROR'),
          http_status: errorStatus(e),
        });
        sendResponse({ error: e?.message || String(e), code: 'LLM_NETWORK_ERROR' });
      });
      return true;
    }

    case 'airglow:identity:getRedirectURL': {
      sendResponse({ url: chrome.identity.getRedirectURL() });
      return true;
    }

    case 'airglow:identity:getUserEmail': {
      chrome.storage.local.get(USER_EMAIL_KEY, (result) => {
        const email = normalizeUserEmail(result[USER_EMAIL_KEY]);
        sendResponse({ email });
      });
      return true;
    }

    case 'airglow:identity:setUserEmail': {
      const email = normalizeUserEmail(msg.email);
      if (!email) {
        sendResponse({ error: 'Enter a valid email address.', code: 'INVALID_EMAIL' });
        return true;
      }
      chrome.storage.local.set({ [USER_EMAIL_KEY]: email }, () => {
        sendResponse({ ok: true, email });
      });
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
            trackUsage(appId, 'open_window', _sender, {
              result: 'error',
              window_type: type,
              wait_close: Boolean(msg.waitClose),
              error_code: 'CHROME_RUNTIME_ERROR',
            });
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          const winId = win?.id;
          if (winId == null) {
            trackUsage(appId, 'open_window', _sender, {
              result: 'error',
              window_type: type,
              wait_close: Boolean(msg.waitClose),
              error_code: 'WINDOW_NOT_CREATED',
            });
            sendResponse({ ok: false, error: 'no window created' });
            return;
          }
          trackUsage(appId, 'open_window', _sender, {
            result: 'success',
            window_type: type,
            wait_close: Boolean(msg.waitClose),
          });
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
          trackUsage(appId, 'open_tab', _sender, {
            result: 'error',
            active: msg.active !== false,
            error_code: 'CHROME_RUNTIME_ERROR',
          });
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        trackUsage(appId, 'open_tab', _sender, {
          result: 'success',
          active: msg.active !== false,
        });
        sendResponse({ ok: true, tabId: tab?.id });
      });
      return true;
    }

    case 'airglow:captureTab': {
      const tabId = _sender.tab?.id;
      if (tabId == null) {
        trackUsage(appId, 'capture_tab', _sender, {
          result: 'error',
          error_code: 'NO_SENDER_TAB',
        });
        sendResponse({ error: 'no sender tab' });
        return true;
      }
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab.windowId) {
          trackUsage(appId, 'capture_tab', _sender, {
            result: 'error',
            error_code: chrome.runtime.lastError ? 'CHROME_RUNTIME_ERROR' : 'TAB_WINDOW_NOT_FOUND',
          });
          sendResponse({ error: 'cannot get tab window' });
          return;
        }
        chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            trackUsage(appId, 'capture_tab', _sender, {
              result: 'error',
              error_code: 'CHROME_RUNTIME_ERROR',
            });
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
          }
          const base64 = dataUrl.split(',')[1];
          trackUsage(appId, 'capture_tab', _sender, {
            result: 'success',
            media_type: 'image/jpeg',
          });
          sendResponse({ base64, mediaType: 'image/jpeg' });
        });
      });
      return true;
    }

    case 'airglow:platform:registerRedirects': {
      const REDIRECTS_KEY = '__platform:redirects';
      chrome.storage.local.get(REDIRECTS_KEY, (result) => {
        const all: Record<string, any[]> = result[REDIRECTS_KEY] as Record<string, any[]> || {};
        all[appId] = msg.rules || [];
        chrome.storage.local.set({ [REDIRECTS_KEY]: all }, () => {
          logger.info(appId, `stored ${(msg.rules || []).length} redirect rule(s)`);
          sendResponse({ ok: true });
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
