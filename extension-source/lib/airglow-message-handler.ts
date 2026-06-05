/**
 * Handles messages from the airglow SDK (userscripts, UI, startup).
 * Provides storage, fetch, logging, RPC proxying, and platform capabilities.
 */

import type { SourcedManifest } from './app-loader';
import { logger } from './logger';
import { USER_EMAIL_KEY, normalizeUserEmail } from './airglow-identity';
import { trackIdentified } from './analytics';

const STORAGE_PREFIX = 'airglow:app:';
const USER_SECRET_PREFIX = 'airglow:secret:';
const DEV_SECRET_PREFIX = 'airglow:dev-secret:';
const DEFAULT_POPUP_WIDTH = 520;
const DEFAULT_POPUP_HEIGHT = 720;
const AIRGLOW_USER_ID_KEY = '__airglow_user_id';

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

/**
 * Fetch via page context: injects a content script into a tab on the target domain.
 * Gives correct cookies (SameSite), Sec-Fetch-* headers, and origin — indistinguishable from a real page request.
 */
async function fetchViaPage(
  url: string, method?: string, headers?: Record<string, string>, body?: string,
): Promise<{ status: number; body: any }> {
  const targetUrl = new URL(url);
  const targetOrigin = targetUrl.origin;

  // Find an existing tab on the target domain
  const tabs = await chrome.tabs.query({ url: `${targetUrl.protocol}//${targetUrl.hostname}/*` });
  let tabId: number;
  let createdTab = false;

  if (tabs.length > 0) {
    tabId = tabs[0].id!;
  } else {
    // Create a background tab on the target domain
    const tab = await chrome.tabs.create({ url: targetOrigin, active: false });
    tabId = tab.id!;
    createdTab = true;
    // Wait for page to load
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
const appSourceMap = new Map<string, string>(); // appId → base URL

export function setAppManifests(manifests: SourcedManifest[]): void {
  appManifests = manifests;
  appSourceMap.clear();
  for (const m of manifests) {
    appSourceMap.set(m.id, m._source.url);
  }
}

export function getAppManifests(): SourcedManifest[] {
  return appManifests;
}

function isClientSetting(appId: string, key: string): boolean {
  const manifest = appManifests.find((m) => m.id === appId);
  if (!manifest?.secrets) return false;
  return key in (manifest.secrets as Record<string, any>);
}

/**
 * Check if a URL matches a Chrome extension match pattern.
 * Pattern: <scheme>://<host>/<path>  (supports *, *.domain, path wildcards)
 */
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

function isUrlAllowedForCookies(appId: string, url: string): boolean {
  const manifest = appManifests.find((m) => m.id === appId);
  if (!manifest?.host_permissions?.length) return false;
  return manifest.host_permissions.some((p) => matchesPattern(p, url));
}

/** Callback invoked when a validated app log message is persisted. */
export type OnAppLog = (appId: string, level: 'info' | 'warn' | 'error', sender: chrome.runtime.MessageSender) => void;

let _onAppLog: OnAppLog | undefined;

export function setOnAppLog(cb: OnAppLog): void {
  _onAppLog = cb;
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

  // Validate appId exists in loaded manifests
  if (!appManifests.some((m) => m.id === appId)) {
    sendResponse({ error: `unknown appId: ${appId}` });
    return true;
  }

  // Validate sender identity via browser-enforced worldId (userscripts)
  // or sender URL (app-shell extension pages). No shared secret needed.
  const senderWorldId = (_sender as any).userScriptWorldId as string | undefined;
  if (senderWorldId) {
    const expectedWorldId = `airglow:${appId}`;
    if (senderWorldId !== expectedWorldId) {
      sendResponse({ error: `appId mismatch: claimed ${appId}, world is ${senderWorldId}` });
      return true;
    }
  }

  const storageKey = (key: string) => `${STORAGE_PREFIX}${appId}:${key}`;

  const handled = dispatchAirglowMessage(msg, appId, storageKey, _sender, sendResponse);
  if (!handled) sendResponse({ error: `unknown message type: ${msg.type}`, code: 'UNKNOWN_MESSAGE_TYPE' });
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
      if (msg.includeCookies) {
        // Page-context fetch: inject into a tab on the target domain.
        // This gives correct cookies (including SameSite) and Sec-Fetch-* headers.
        if (!isUrlAllowedForCookies(appId, msg.url)) {
          sendResponse({ error: `app "${appId}" lacks host_permissions for ${new URL(msg.url).hostname}` });
          return true;
        }
        fetchViaPage(msg.url, msg.method, msg.headers, msg.body)
          .then((result) => sendResponse(result))
          .catch((e) => sendResponse({ error: e.message }));
      } else {
        // SW fetch: CORS-free, no cookies
        const fetchOpts: RequestInit = {
          method: msg.method || 'GET',
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
          .catch((e) => sendResponse({ error: e.message }));
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
      const baseUrl = appSourceMap.get(appId);
      if (!baseUrl) {
        console.error(`[airglow] RPC failed: no source registered for app '${appId}'`);
        sendResponse({
          error: `No source registered for app '${appId}'. Is the dev server running?`,
          code: 'RPC_SOURCE_NOT_REGISTERED',
        });
        return true;
      }
      getAirglowRpcIdentity()
        .then((identity) => fetch(`${baseUrl}/api/apps/${appId}/rpc/${msg.functionName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Airglow-User-Id': identity.userId,
            ...(identity.email ? { 'X-Airglow-User-Email': identity.email } : {}),
          },
          body: JSON.stringify(msg.payload),
        }))
        .then(async (res) => {
          const text = await res.text();
          let result;
          try { result = JSON.parse(text); } catch { result = text; }
          if (!res.ok) {
            const envelope = result && typeof result === 'object' ? result as Record<string, any> : {};
            sendResponse({
              error: typeof envelope.error === 'string'
                ? envelope.error
                : `RPC '${msg.functionName}' failed with HTTP ${res.status}`,
              code: typeof envelope.code === 'string' ? envelope.code : 'RPC_HTTP_ERROR',
              status: res.status,
              requestId: typeof envelope.requestId === 'string' ? envelope.requestId : undefined,
              details: result,
            });
            return;
          }
          sendResponse({ result });
        })
        .catch((e) => sendResponse({ error: e.message, code: 'RPC_NETWORK_ERROR' }));
      return true;
    }

    case 'airglow:llm:anthropic:messages': {
      const baseUrl = appSourceMap.get(appId);
      if (!baseUrl) {
        console.error(`[airglow] LLM request failed: no source registered for app '${appId}'`);
        sendResponse({
          error: `No source registered for app '${appId}'. Is an app source reachable?`,
          code: 'LLM_SOURCE_NOT_REGISTERED',
        });
        return true;
      }
      getAirglowRpcIdentity()
        .then((identity) => fetch(`${baseUrl}/api/llm/anthropic/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Airglow-App-Id': appId,
            'X-Airglow-User-Id': identity.userId,
            ...(identity.email ? { 'X-Airglow-User-Email': identity.email } : {}),
          },
          body: JSON.stringify(msg.payload),
        }))
        .then(async (res) => {
          const text = await res.text();
          let result;
          try { result = JSON.parse(text); } catch { result = text; }
          if (!res.ok) {
            const envelope = result && typeof result === 'object' ? result as Record<string, any> : {};
            sendResponse({
              error: typeof envelope.error === 'string'
                ? envelope.error
                : `LLM request failed with HTTP ${res.status}`,
              code: typeof envelope.code === 'string' ? envelope.code : 'LLM_HTTP_ERROR',
              status: res.status,
              requestId: typeof envelope.requestId === 'string' ? envelope.requestId : undefined,
              details: result,
            });
            return;
          }
          sendResponse({ result });
        })
        .catch((e) => sendResponse({ error: e.message, code: 'LLM_NETWORK_ERROR' }));
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
        // First-time identification — fire-and-forget. trackIdentified dedupes
        // via __airglow_identified_tracked, so this can run on every set.
        trackIdentified().catch((e) =>
          logger.warn('airglow', `trackIdentified failed: ${e instanceof Error ? e.message : String(e)}`)
        );
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
          if (!msg.waitClose) {
            sendResponse({ ok: true, windowId: win?.id });
            return;
          }
          const winId = win?.id;
          if (winId == null) { sendResponse({ ok: false, error: 'no window created' }); return; }
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

    case 'airglow:platform:registerRedirects': {
      // Store redirect rules namespaced per app under a shared platform key.
      // Background reads this to set up webNavigation listeners.
      const REDIRECTS_KEY = '__platform:redirects';
      chrome.storage.local.get(REDIRECTS_KEY, (result) => {
        const all: Record<string, any[]> = result[REDIRECTS_KEY] as Record<string, any[]> || {};
        all[appId] = msg.rules || [];
        chrome.storage.local.set({ [REDIRECTS_KEY]: all }, () => {
          console.log(`[airglow/${appId}] Stored ${(msg.rules || []).length} redirect rule(s)`);
          sendResponse({ ok: true });
        });
      });
      return true;
    }

    case 'airglow:platform:allowIframes': {
      // Store iframe-allowed domains per app. Background syncs declarativeNetRequest rules.
      const IFRAME_KEY = '__platform:iframeAllow';
      chrome.storage.local.get(IFRAME_KEY, (result) => {
        const all: Record<string, any> = result[IFRAME_KEY] as Record<string, any> || {};
        all[appId] = { domains: msg.domains || [], initiators: msg.initiators || [] };
        chrome.storage.local.set({ [IFRAME_KEY]: all }, () => {
          console.log(`[airglow/${appId}] Stored ${(msg.domains || []).length} iframe-allow domain(s)`);
          // Background picks up the change via storage.onChanged → syncIframeRules
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
