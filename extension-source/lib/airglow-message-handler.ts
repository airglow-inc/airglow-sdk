/**
 * Handles messages from the airglow SDK (userscripts, UI, startup).
 * Provides storage, fetch, logging, RPC proxying, and platform capabilities.
 */

import type { AppSource, SourcedManifest } from './app-loader';
import { logger } from './logger';
import {
  buildIdentityHeaders,
  getAirglowIdentity,
  getAirglowIdentityHeaders,
  USER_EMAIL_KEY,
  normalizeUserEmail,
} from './airglow-identity';
import { trackIdentified } from './analytics';
import { airglowUserScriptWorldId } from './airglow-world-id';

const STORAGE_PREFIX = 'airglow:app:';
const USER_SECRET_PREFIX = 'airglow:secret:';
const DEV_SECRET_PREFIX = 'airglow:dev-secret:';
const DEFAULT_POPUP_WIDTH = 520;
const DEFAULT_POPUP_HEIGHT = 720;
const APP_MANIFESTS_KEY = '__app_manifests';
const REMOTE_RPC_TIMEOUT_MS = 30000;
const REMOTE_RPC_RETRY_DELAYS_MS = [500, 1500];
const LLM_TIMEOUT_MS = 60000;
const LLM_RETRY_DELAYS_MS = [500, 1500];
const RUNTIME_USER_APPROVAL_FLAG = '_airglowRuntimeUserApproved';
const MAX_REPLACE_EDITOR_TEXT_CHARS = 200_000;

export const RUNTIME_UX_CAPABILITIES = {
  fetchIncludeCookies: 'fetch.includeCookies',
  identityLaunchWebAuthFlow: 'identity.launchWebAuthFlow',
  openWindow: 'browser.openWindow',
  openTab: 'browser.openTab',
  captureTab: 'browser.captureTab',
  registerRedirects: 'platform.registerRedirects',
  allowIframes: 'platform.allowIframes',
} as const;

export type RuntimeUxCapability = typeof RUNTIME_UX_CAPABILITIES[keyof typeof RUNTIME_UX_CAPABILITIES];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRetryHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function appStorageKey(appId: string, key: string): string {
  return `${STORAGE_PREFIX}${appId}:${key}`;
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Airglow request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessageFromEnvelope(envelope: Record<string, any>, fallback: string): string {
  if (typeof envelope.error === 'string') return envelope.error;
  if (envelope.error && typeof envelope.error === 'object' && typeof envelope.error.message === 'string') {
    return envelope.error.message;
  }
  if (typeof envelope.message === 'string') return envelope.message;
  return fallback;
}

function errorCodeFromEnvelope(envelope: Record<string, any>, fallback: string): string {
  if (typeof envelope.code === 'string') return envelope.code;
  if (envelope.error && typeof envelope.error === 'object' && typeof envelope.error.code === 'string') {
    return envelope.error.code;
  }
  return fallback;
}

function requestIdFromEnvelope(envelope: Record<string, any>): string | undefined {
  if (typeof envelope.requestId === 'string') return envelope.requestId;
  if (envelope.error && typeof envelope.error === 'object' && typeof envelope.error.requestId === 'string') {
    return envelope.error.requestId;
  }
  return undefined;
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
  const identityHeaders = source.type === 'cloud'
    ? await getAirglowIdentityHeaders({ requireSession: true })
    : buildIdentityHeaders(await getAirglowIdentity());
  const baseUrl = source.url.replace(/\/+$/, '');
  const url = `${baseUrl}/api/apps/${encodeURIComponent(appId)}/rpc/${encodeURIComponent(functionName)}`;
  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...identityHeaders,
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
  const manifest = appManifests.find((m) => m.id === appId);
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
  const manifest = appManifests.find((m) => m.id === appId);
  if (!manifest?.host_permissions?.length) return false;
  return manifest.host_permissions.some((p) => matchesPattern(p, url));
}

export function requiredRuntimeUxCapabilityForMessage(msg: any): RuntimeUxCapability | undefined {
  switch (msg?.type) {
    case 'airglow:fetch':
      return msg.includeCookies ? RUNTIME_UX_CAPABILITIES.fetchIncludeCookies : undefined;
    case 'airglow:identity:launchWebAuthFlow':
      return RUNTIME_UX_CAPABILITIES.identityLaunchWebAuthFlow;
    case 'airglow:openWindow':
      return RUNTIME_UX_CAPABILITIES.openWindow;
    case 'airglow:openTab':
      return RUNTIME_UX_CAPABILITIES.openTab;
    case 'airglow:captureTab':
      return RUNTIME_UX_CAPABILITIES.captureTab;
    case 'airglow:platform:registerRedirects':
      return RUNTIME_UX_CAPABILITIES.registerRedirects;
    case 'airglow:platform:allowIframes':
      return RUNTIME_UX_CAPABILITIES.allowIframes;
    default:
      return undefined;
  }
}

export function requiredRuntimeUserApprovalCapabilityForMessage(msg: any): RuntimeUxCapability | undefined {
  switch (msg?.type) {
    case 'airglow:identity:launchWebAuthFlow':
      return RUNTIME_UX_CAPABILITIES.identityLaunchWebAuthFlow;
    case 'airglow:openWindow':
      return RUNTIME_UX_CAPABILITIES.openWindow;
    case 'airglow:openTab':
      return RUNTIME_UX_CAPABILITIES.openTab;
    default:
      return undefined;
  }
}

function appHasRuntimeUxCapability(appId: string, capability: RuntimeUxCapability): boolean {
  const manifest = appManifests.find((m) => m.id === appId);
  if (!manifest) return false;
  return Array.isArray(manifest.capabilities) && manifest.capabilities.includes(capability);
}

function senderHasTrustedRuntimeApproval(sender: chrome.runtime.MessageSender, appId: string): boolean {
  if (!sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:'
      && url.pathname.endsWith('/app-shell.html')
      && url.searchParams.get('app') === appId;
  } catch {
    return false;
  }
}

function hasTrustedRuntimeUserApproval(msg: any, appId: string, sender: chrome.runtime.MessageSender): boolean {
  return msg?.[RUNTIME_USER_APPROVAL_FLAG] === true && senderHasTrustedRuntimeApproval(sender, appId);
}

function targetFromMessage(msg: any): string {
  const value = typeof msg?.url === 'string' ? msg.url : '';
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.hostname ? ` for ${url.hostname}` : '';
  } catch {
    return '';
  }
}

function runtimeApprovalPrompt(appId: string, msg: any, capability: RuntimeUxCapability): string {
  const action = capability === RUNTIME_UX_CAPABILITIES.openTab
    ? 'open a browser tab'
    : capability === RUNTIME_UX_CAPABILITIES.openWindow
      ? 'open a browser window'
      : 'open an authentication window';
  return `Airglow app "${appId}" wants to ${action}${targetFromMessage(msg)}. Allow this action?`;
}

function normalizeEditorTextFromMessage(msg: any): string {
  const text = typeof msg?.text === 'string' ? msg.text : '';
  return text.slice(0, MAX_REPLACE_EDITOR_TEXT_CHARS);
}

function normalizeEditorSelectorsFromMessage(msg: any): string[] {
  if (!Array.isArray(msg?.selectors)) return [];
  return msg.selectors
    .filter((selector: unknown): selector is string => typeof selector === 'string')
    .map((selector) => selector.trim())
    .filter(Boolean)
    .slice(0, 20);
}

async function replacePageEditorText(
  sender: chrome.runtime.MessageSender,
  text: string,
  selectors: string[],
): Promise<unknown> {
  const tabId = sender.tab?.id;
  if (tabId == null) throw new Error('No sender tab for page editor insertion');
  const target: chrome.scripting.InjectionTarget = { tabId };
  if (typeof sender.frameId === 'number') target.frameIds = [sender.frameId];
  const [result] = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    args: [text, selectors],
    func: (nextText: string, customSelectors: string[]) => {
      const defaultSelectors = [
        '.monaco-editor textarea.inputarea',
        '.monaco-editor textarea',
        '.cm-content[contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        '[role="textbox"][contenteditable="true"]',
        'textarea',
      ];
      const selectors = [...customSelectors, ...defaultSelectors];

      function textValue(value: unknown): string {
        return String(value || '');
      }

      function isVisible(element: Element): boolean {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }

      function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
        element.focus();
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor?.set) descriptor.set.call(element, value);
        else element.value = value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      function setEditableText(element: HTMLElement, value: string): boolean {
        element.focus();
        const selection = getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const inserted = document.execCommand('insertText', false, value);
        if (!inserted) element.textContent = value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      function scoreMonacoModel(model: any): number {
        const uri = textValue(model?.uri).toLowerCase();
        const language = textValue(typeof model?.getLanguageId === 'function' ? model.getLanguageId() : '').toLowerCase();
        const value = textValue(typeof model?.getValue === 'function' ? model.getValue() : '');
        let score = 0;
        if (uri.includes('solution')) score += 50;
        if (uri.includes('leetcode')) score += 20;
        if (uri.includes('editor')) score += 10;
        if (/javascript|typescript|python|java|cpp|c\+\+|golang|go|rust|csharp|kotlin|swift/.test(language)) score += 12;
        if (/\b(class\s+Solution|function\s+\w+|def\s+\w+|impl\s+Solution|public\s+class|vector\s*<|ListNode|TreeNode)\b/.test(value)) score += 35;
        if (value.length > 0 && value.length < 20000) score += 5;
        return score;
      }

      function replaceMonaco(): { ok: boolean; method?: string; modelUri?: string } {
        const monaco = (globalThis as any).monaco;
        const models = monaco?.editor?.getModels?.();
        if (!Array.isArray(models) || models.length === 0) return { ok: false };
        const candidates = models
          .filter((model) => typeof model?.setValue === 'function')
          .map((model) => ({ model, score: scoreMonacoModel(model) }))
          .sort((left, right) => right.score - left.score);
        const chosen = candidates[0]?.model;
        if (!chosen) return { ok: false };
        chosen.setValue(nextText);
        return { ok: true, method: 'monaco', modelUri: textValue(chosen.uri) };
      }

      const monacoResult = replaceMonaco();
      if (monacoResult.ok) return monacoResult;

      for (const selector of selectors) {
        let elements: Element[] = [];
        try {
          elements = Array.from(document.querySelectorAll(selector));
        } catch {
          continue;
        }
        const target = elements.find(isVisible) || elements[0];
        if (!target) continue;
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
          return setNativeValue(target, nextText)
            ? { ok: true, method: 'textarea', selector }
            : { ok: false, method: 'textarea', selector };
        }
        if (target instanceof HTMLElement && target.isContentEditable) {
          return setEditableText(target, nextText)
            ? { ok: true, method: 'contenteditable', selector }
            : { ok: false, method: 'contenteditable', selector };
        }
      }

      return { ok: false, error: 'No editable code surface found' };
    },
  });
  return result?.result ?? { ok: false, error: 'Page editor insertion returned no result' };
}

async function requestRuntimeUserApproval(
  appId: string,
  msg: any,
  capability: RuntimeUxCapability,
  sender: chrome.runtime.MessageSender,
): Promise<boolean> {
  const tabId = sender.tab?.id;
  if (tabId == null) return false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (text: string) => window.confirm(text),
      args: [runtimeApprovalPrompt(appId, msg, capability)],
    });
    return results.some((result) => result.result === true);
  } catch (error) {
    logger.warn(appId, `runtime approval prompt failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export type OnAppLog = (appId: string, level: 'info' | 'warn' | 'error', sender: chrome.runtime.MessageSender) => void;
let _onAppLog: OnAppLog | undefined;
export function setOnAppLog(cb: OnAppLog): void { _onAppLog = cb; }

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
      const expectedWorldId = airglowUserScriptWorldId(appId);
      if (senderWorldId !== expectedWorldId) {
        sendResponse({ error: `appId mismatch: claimed ${appId}, world is ${senderWorldId}` });
        return;
      }
    }

    const handled = dispatchAirglowMessage(msg, appId, (key) => appStorageKey(appId, key), _sender, sendResponse);
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
  runtimeApprovalAlreadyGranted = false,
): boolean {

  try {
    const requiredCapability = requiredRuntimeUxCapabilityForMessage(msg);
    if (requiredCapability && !appHasRuntimeUxCapability(appId, requiredCapability)) {
      sendResponse({
        error: `app "${appId}" lacks manifest capability "${requiredCapability}" for ${msg.type}`,
        code: 'CAPABILITY_DENIED',
        capability: requiredCapability,
      });
      return true;
    }
    const requiredApprovalCapability = requiredRuntimeUserApprovalCapabilityForMessage(msg);
    if (
      requiredApprovalCapability
      && !runtimeApprovalAlreadyGranted
      && !hasTrustedRuntimeUserApproval(msg, appId, _sender)
    ) {
      requestRuntimeUserApproval(appId, msg, requiredApprovalCapability, _sender)
        .then((approved) => {
          if (!approved) {
            sendResponse({
              error: `User approval is required for ${msg.type}`,
              code: 'RUNTIME_USER_APPROVAL_DENIED',
              capability: requiredApprovalCapability,
            });
            return;
          }
          dispatchAirglowMessage(msg, appId, storageKey, _sender, sendResponse, true);
        })
        .catch((error) => {
          sendResponse({
            error: error instanceof Error ? error.message : String(error),
            code: 'RUNTIME_USER_APPROVAL_ERROR',
            capability: requiredApprovalCapability,
          });
        });
      return true;
    }

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
      // host_permissions enforcement applies to ALL fetches (not just cookie
      // ones). Without this, a cloud app could exfiltrate to any URL via
      // the extension's privileged context (CORS-bypass, no SOP).
      let targetUrl: URL;
      try {
        targetUrl = new URL(String(msg.url || ''));
      } catch {
        sendResponse({ error: 'invalid fetch URL', code: 'INVALID_FETCH_URL' });
        return true;
      }
      if (!isUrlAllowedForFetch(appId, targetUrl.href)) {
        sendResponse({
          error: `app "${appId}" lacks host_permissions for ${targetUrl.hostname}`,
          code: 'FETCH_HOST_PERMISSION_DENIED',
        });
        return true;
      }
      if (msg.includeCookies) {
        fetchViaPage(msg.url, msg.method, msg.headers, msg.body)
          .then((result) => sendResponse(result))
          .catch((e) => sendResponse({ error: e.message }));
      } else {
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
      const source = appSourceMap.get(appId);
      if (!source) {
        logger.warn('airglow', `RPC failed: no source registered for app '${appId}'`);
        sendResponse({
          error: `No source registered for app '${appId}'. Is an app source reachable?`,
          code: 'RPC_SOURCE_NOT_REGISTERED',
        });
        return true;
      }
      // Server-eval against whichever source owns this app: local apps run on
      // the dev server, cloud apps run on the cloud. No client-side execution.
      executeRemoteRpc(appId, source, String(msg.functionName || ''), msg.payload)
        .then((result) => sendResponse({ result }))
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

    case 'airglow:llm:anthropic:messages': {
      const source = appSourceMap.get(appId);
      if (!source) {
        sendResponse({
          error: `No source registered for app '${appId}'. Is an app source reachable?`,
          code: 'LLM_SOURCE_NOT_REGISTERED',
        });
        return true;
      }
      const baseUrl = source.url.replace(/\/+$/, '');
      const url = `${baseUrl}/api/llm/anthropic/messages`;
      (async () => {
        const identityHeaders = source.type === 'cloud'
          ? await getAirglowIdentityHeaders({ requireSession: true })
          : buildIdentityHeaders(await getAirglowIdentity());
        const requestInit: RequestInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Airglow-App-Id': appId,
            ...identityHeaders,
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
                errorMessageFromEnvelope(envelope, `LLM request failed with HTTP ${res.status}`),
              ) as Error & { code?: string; status?: number; requestId?: string; details?: unknown };
              error.code = errorCodeFromEnvelope(envelope, 'LLM_HTTP_ERROR');
              error.status = res.status;
              error.requestId = requestIdFromEnvelope(envelope);
              error.details = result;
              lastError = error;
              if (shouldRetryHttpStatus(res.status) && attempt < LLM_RETRY_DELAYS_MS.length) {
                await sleep(LLM_RETRY_DELAYS_MS[attempt]);
                continue;
              }
              throw error;
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
      })().catch((e) => sendResponse({ error: e?.message || String(e), code: 'LLM_NETWORK_ERROR' }));
      return true;
    }

    case 'airglow:page:replaceEditorText': {
      replacePageEditorText(_sender, normalizeEditorTextFromMessage(msg), normalizeEditorSelectorsFromMessage(msg))
        .then((result) => sendResponse({ result }))
        .catch((error) => sendResponse({
          error: error instanceof Error ? error.message : String(error),
          code: 'PAGE_EDITOR_REPLACE_FAILED',
        }));
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
