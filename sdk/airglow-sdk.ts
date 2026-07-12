/**
 * Airglow SDK — injected into app contexts before app code runs.
 * Provides airglow.fetch, airglow.storage, airglow.log, airglow.rpc, airglow.llm, and airglow.platform.
 *
 * Transport selection:
 * - app_ui context: ALWAYS window.parent.postMessage (the dashboard bridge).
 *   App UIs load at the local daemon's web origin where chrome.runtime.sendMessage
 *   exists but requires an extension id — calling it there throws.
 * - Userscripts/startup/extension pages: chrome.runtime.sendMessage, with a
 *   postMessage fallback when chrome.runtime is absent (sandboxed iframes).
 *
 * Disable/delete safety:
 * `storage` is app-scoped key-value — background doesn't act on it, safe to ignore.
 * `platform` writes persistent config that background listeners actively consume.
 * Any such endpoint MUST tag entries with appId so background can skip disabled
 * apps (__disabled_apps).
 */

export const AIRGLOW_SDK_CONTRACT_VERSION = '0.1.0-beta.2';

export type AirglowSdkContext = 'userscript' | 'app_ui' | 'startup';

export function buildSdkCode(appId: string, context: AirglowSdkContext = 'app_ui'): string {
  return `
(function() {
  const APP_ID = ${JSON.stringify(appId)};
  const SDK_VERSION = ${JSON.stringify(AIRGLOW_SDK_CONTRACT_VERSION)};
  const SDK_CONTEXT = ${JSON.stringify(context)};
  const usePostMessage = SDK_CONTEXT === 'app_ui'
    || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage;

  let callCounter = 0;
  const pendingCalls = {};

  function makeAirglowError(response) {
    const error = new Error(response?.error || 'Airglow SDK call failed');
    error.name = 'AirglowError';
    if (response?.code) error.code = response.code;
    if (response?.status) error.status = response.status;
    if (response?.requestId) error.requestId = response.requestId;
    if (response?.details !== undefined) error.details = response.details;
    if (response?.onboardingUrl) error.onboardingUrl = response.onboardingUrl;
    return error;
  }

  function runtimeErrorPayload(kind, error, extras) {
    const message = error?.message || String(error || kind);
    return {
      kind,
      message,
      name: error?.name,
      stack: error?.stack,
      ...extras,
    };
  }

  function notifyRuntimeError(payload) {
    if (usePostMessage && globalThis.parent && globalThis.parent !== globalThis) {
      globalThis.parent.postMessage({
        _airglow_app_error: true,
        appId: APP_ID,
        sdkVersion: SDK_VERSION,
        ...payload,
      }, '*');
    }
  }

  function logRuntimeError(payload) {
    sendMsg({
      type: 'airglow:log',
      level: 'error',
      message: payload.message || 'Unhandled app error',
      stack: payload.stack,
      data: {
        kind: payload.kind,
        name: payload.name,
        filename: payload.filename,
        lineno: payload.lineno,
        colno: payload.colno,
      },
    }).catch(function() {});
  }

  // Listen for postMessage responses from parent (the dashboard)
  if (usePostMessage) {
    window.addEventListener('message', function(e) {
      if (e.data?._airglow_response && e.data._callId != null) {
        const cb = pendingCalls[e.data._callId];
        if (cb) {
          delete pendingCalls[e.data._callId];
          cb(e.data);
        }
      }
    });
  }

  function sendMsg(payload) {
    if (usePostMessage) {
      return new Promise((resolve, reject) => {
        const callId = callCounter++;
        pendingCalls[callId] = (response) => {
          if (response?.error) reject(makeAirglowError(response));
          else resolve(response);
        };
        window.parent.postMessage(
          { ...payload, _airglow: true, _appId: APP_ID, _callId: callId },
          '*'
        );
      });
    }
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { ...payload, _airglow: true, _appId: APP_ID },
        async (response) => {
          if (chrome.runtime.lastError) {
            reject(makeAirglowError({
              error: chrome.runtime.lastError.message,
              code: 'CHROME_RUNTIME_ERROR',
            }));
          } else if (response?.error) {
            reject(makeAirglowError(response));
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  const storage = {
    async get(key) {
      const res = await sendMsg({ type: 'airglow:storage:get', key });
      return res?.value;
    },
    async set(key, value) {
      await sendMsg({ type: 'airglow:storage:set', key, value });
    },
    async delete(key) {
      await sendMsg({ type: 'airglow:storage:delete', key });
    },
    async list() {
      const res = await sendMsg({ type: 'airglow:storage:list' });
      return res?.keys ?? [];
    },
  };

  const log = {
    async info(message, data) {
      await sendMsg({ type: 'airglow:log', level: 'info', message, data });
    },
    async warn(message, data) {
      await sendMsg({ type: 'airglow:log', level: 'warn', message, data });
    },
    async error(message, data) {
      await sendMsg({ type: 'airglow:log', level: 'error', message, data });
    },
  };

  // Auto-capture uncaught errors. In userscript context our code is injected
  // into a host page (e.g. Outlook), so the handler also fires for the host's
  // own errors (ResizeObserver loops, …) — we report only frames tagged
  // "airglow-app://" by app-loader's injected "//# sourceURL=" directive. In
  // app_ui context the whole iframe IS the app and its bundle is served from
  // the daemon origin (never tagged), so every error is ours: report them all.
  // Without this, app_ui runtime crashes were silently dropped — no crash
  // overlay, nothing in the daemon log.
  function isAppError(filename, stack) {
    if (SDK_CONTEXT === 'app_ui') return true;
    if (typeof filename === 'string' && filename.indexOf('airglow-app://') === 0) return true;
    if (typeof stack === 'string' && stack.indexOf('airglow-app://') !== -1) return true;
    return false;
  }
  window.addEventListener('error', function(e) {
    if (!isAppError(e.filename, e.error?.stack)) return;
    const payload = runtimeErrorPayload('uncaught_error', e.error || e.message, {
      message: e.message || e.error?.message || 'Uncaught error',
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
    });
    notifyRuntimeError(payload);
    logRuntimeError(payload);
  });
  window.addEventListener('unhandledrejection', function(e) {
    const reason = e.reason;
    if (!isAppError(reason?.fileName, reason?.stack)) return;
    const payload = runtimeErrorPayload('unhandled_rejection', reason, {
      message: reason?.message || 'Unhandled promise rejection',
    });
    notifyRuntimeError(payload);
    logRuntimeError(payload);
  });

  async function airglowFetch(url, opts = {}) {
    const { includeCookies, ...fetchOpts } = opts;
    const res = await sendMsg({
      type: 'airglow:fetch',
      url,
      method: fetchOpts.method || 'GET',
      headers: fetchOpts.headers,
      body: fetchOpts.body,
      includeCookies: !!includeCookies,
    });
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      json: () => Promise.resolve(res.body),
      text: () => Promise.resolve(typeof res.body === 'string' ? res.body : JSON.stringify(res.body)),
    };
  }

  async function rpc(functionName, payload) {
    const res = await sendMsg({ type: 'airglow:rpc', functionName, payload });
    // Transport/crash failures arrive as an error envelope (no result). Throw
    // so callers see the real reason instead of a downstream "undefined.foo".
    // A server fn returning { ok:false, ... } is still a success envelope and
    // passes through unchanged.
    if (res?.error) {
      const err = new Error(res.error);
      if (res.code) err.code = res.code;
      if (res.status) err.status = res.status;
      if (res.details) err.details = res.details;
      throw err;
    }
    return res?.result;
  }

  const platform = {
    async allowIframes(domains, initiators) {
      await sendMsg({ type: 'airglow:platform:allowIframes', domains, initiators: initiators || [] });
    },
  };

  const identity = {
    async launchWebAuthFlow(url) {
      const res = await sendMsg({ type: 'airglow:identity:launchWebAuthFlow', url });
      return res?.redirectUrl;
    },
    async getRedirectURL() {
      const res = await sendMsg({ type: 'airglow:identity:getRedirectURL' });
      return res?.url;
    },
  };

  // Third-party tools (Gmail, Notion, Sheets, …) via the daemon's connector
  // service. Connections are scoped to this app; \`account\` labels distinguish
  // multiple identities on the same service (e.g. two Google accounts).
  // connect() opens the OAuth popup and resolves once the connection is live.
  const connectors = {
    async connect(toolkit, opts) {
      const res = await sendMsg({ type: 'airglow:connectors:connect', toolkit, account: opts && opts.account });
      return { toolkit, connected: !!res?.connected };
    },
    async status(toolkit, opts) {
      const res = await sendMsg({ type: 'airglow:connectors:status', toolkit, account: opts && opts.account });
      return { connected: !!res?.connected };
    },
    async disconnect(toolkit, opts) {
      await sendMsg({ type: 'airglow:connectors:disconnect', toolkit, account: opts && opts.account });
    },
    async execute(tool, args, opts) {
      const res = await sendMsg({ type: 'airglow:connectors:execute', tool, arguments: args || {}, account: opts && opts.account });
      return { data: res?.data, successful: !!res?.successful, error: res?.error ?? null };
    },
  };

  // Streaming transport: sendMsg is one-shot request/response on every path
  // (chrome.runtime.sendMessage and the dashboard postMessage bridge), so the
  // background can't push events to us. Instead it buffers SSE events per
  // stream and we poll. ~300ms polling is invisible next to multi-second
  // model latency, and it reuses the existing bridge unchanged in all three
  // contexts (userscript / app_ui iframe / startup).
  const LLM_STREAM_POLL_MS = 300;
  async function llmChatStreaming(payload, onEvent) {
    const start = await sendMsg({ type: 'airglow:llm:chat', payload, stream: true });
    const streamId = start?.streamId;
    if (!streamId) throw makeAirglowError({ error: 'streaming start failed: no streamId', code: 'LLM_STREAM_ERROR' });
    while (true) {
      // sendMsg rejects on an error envelope — upstream failures (budget,
      // auth, mid-stream cut) surface here as AirglowError.
      const res = await sendMsg({ type: 'airglow:llm:stream:poll', streamId });
      const events = Array.isArray(res?.events) ? res.events : [];
      for (const e of events) {
        try { onEvent(e); } catch (err) { logRuntimeError(runtimeErrorPayload('llm_onevent_error', err, {})); }
      }
      if (res?.done) return res.result;
      // Drain a bursty buffer immediately; idle-wait otherwise.
      if (events.length === 0) await new Promise((r) => setTimeout(r, LLM_STREAM_POLL_MS));
    }
  }

  const llm = {
    // OpenAI chat-completions schema, proxied to OpenRouter by the gateway.
    async chat(payload, opts) {
      // Opt-in streaming: observe raw OpenAI-style stream chunks while the
      // call runs; resolves with the same complete completion object as the
      // buffered path.
      if (opts && typeof opts.onEvent === 'function') {
        return llmChatStreaming(payload, opts.onEvent);
      }
      const res = await sendMsg({ type: 'airglow:llm:chat', payload });
      // Surface gateway failures (budget exhausted, rate limit, validation)
      // as a throw rather than silently returning undefined — otherwise the
      // caller mistakes a backend error for an empty/garbage completion.
      if (res?.error) {
        const err = new Error(res.error);
        if (res.code) err.code = res.code;
        if (res.status) err.status = res.status;
        if (res.details) err.details = res.details;
        throw err;
      }
      return res?.result;
    },
  };

  async function captureTab() {
    const res = await sendMsg({ type: 'airglow:captureTab' });
    if (res?.error) throw new Error(res.error);
    return { base64: res.base64, mediaType: res.mediaType };
  }

  // Read one cookie (by name) set on \`url\`'s domain, from the browser's real
  // cookie jar — including HttpOnly cookies a page's document.cookie can't see.
  // Returns the value string, or null if absent. Pairs with
  // fetch({ includeCookies: true }) for authenticated cross-site reads that
  // need a double-submit header (e.g. an X csrf token that must equal ct0).
  async function getCookie(url, name) {
    const res = await sendMsg({ type: 'airglow:cookie:get', url, name });
    if (res?.error) throw new Error(res.error);
    return res?.value ?? null;
  }

  async function openWindow(url, opts = {}) {
    await sendMsg({ type: 'airglow:openWindow', url, width: opts.width, height: opts.height, left: opts.left, top: opts.top, popup: opts.popup });
  }

  async function openWindowAndWaitClose(url, opts = {}) {
    await sendMsg({ type: 'airglow:openWindow', url, width: opts.width, height: opts.height, left: opts.left, top: opts.top, popup: opts.popup, waitClose: true });
  }

  async function openTab(url, opts = {}) {
    await sendMsg({ type: 'airglow:openTab', url, active: opts.active });
  }

  // Dashboard actions (app_ui context only). These post to the dashboard
  // parent, which relays them to the extension background — the same
  // {_airglow:true} channel sendMsg already uses. Outside the dashboard iframe
  // (standalone tab, userscript, startup) they degrade gracefully so callers
  // can fall back. Replaces the former shared/lib/appShellBridge module.
  function inDashboard() {
    return SDK_CONTEXT === 'app_ui'
      && typeof window !== 'undefined' && window.parent && window.parent !== window;
  }

  // Open an installed app inside the dashboard. Works from any context (app UI,
  // userscript): the background resolves the extension URL, so callers never
  // hardcode the extension id. opts.page selects the app's sub-page (surfaced
  // to its UI as __airglow_params.page); opts.window opens a focused popup
  // window instead of reusing the dashboard tab.
  async function openApp(appId, opts = {}) {
    await sendMsg({
      type: 'airglow:open-app',
      appId,
      page: opts.page,
      window: opts.window === true,
      width: opts.width,
      height: opts.height,
    });
  }

  // background's open-dashboard branch never calls sendResponse — fire and
  // forget (the tab still opens; the relay's port-closed error is irrelevant).
  // An optional target selects the dashboard view (Apps / Catalog / Logs /
  // Settings) so callers can deep-link a specific dashboard view.
  function openDashboard(target) {
    if (!inDashboard()) return;
    var page = target && target.page;
    var msg = page ? { type: 'airglow:open-dashboard', page: page } : { type: 'airglow:open-dashboard' };
    sendMsg(msg).catch(function() {});
  }

  async function listApps() {
    if (!inDashboard()) return [];
    const res = await sendMsg({ type: 'airglow:get-dashboard-manifests' });
    return Array.isArray(res?.manifests) ? res.manifests : [];
  }

  // Userscript world only: stamp every element the app attaches to the page
  // with data-airglow-app="<id>" so the extension can attribute on-page UI to
  // apps (the sidepanel's Visible/Hidden status probes for these). The
  // patched prototypes belong to this app's isolated USER_SCRIPT world — the
  // page's own DOM methods are untouched.
  if (SDK_CONTEXT === 'userscript' && typeof Element !== 'undefined') {
    try {
      const STAMP = 'data-airglow-app';
      const stamp = function(node) {
        try {
          if (!node) return;
          if (node.nodeType === 1) {
            if (!node.hasAttribute(STAMP)) node.setAttribute(STAMP, APP_ID);
          } else if (node.nodeType === 11) {
            // Fragments unwrap on insert — stamp their element children.
            for (let i = 0; i < node.children.length; i++) stamp(node.children[i]);
          }
        } catch (e) {}
      };
      const patch = function(proto, name, firstOnly) {
        const orig = proto[name];
        if (typeof orig !== 'function') return;
        Object.defineProperty(proto, name, {
          value: function() {
            if (firstOnly) stamp(arguments[0]);
            else for (let i = 0; i < arguments.length; i++) stamp(arguments[i]);
            return orig.apply(this, arguments);
          },
          writable: true,
          configurable: true,
        });
      };
      patch(Node.prototype, 'appendChild', true);
      patch(Node.prototype, 'insertBefore', true);
      patch(Node.prototype, 'replaceChild', true);
      for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
        patch(proto, 'append', false);
        patch(proto, 'prepend', false);
      }
      patch(Element.prototype, 'after', false);
      patch(Element.prototype, 'before', false);
      patch(Element.prototype, 'replaceWith', false);
      const origInsertAdjacent = Element.prototype.insertAdjacentElement;
      if (typeof origInsertAdjacent === 'function') {
        Element.prototype.insertAdjacentElement = function(position, el) {
          stamp(el);
          return origInsertAdjacent.call(this, position, el);
        };
      }
    } catch (e) {}
  }

  globalThis.airglow = {
    sdkVersion: SDK_VERSION,
    fetch: airglowFetch,
    storage,
    log,
    rpc,
    llm,
    connectors,
    platform,
    identity,
    captureTab,
    getCookie,
    openWindow,
    openWindowAndWaitClose,
    openTab,
    openApp,
    openDashboard,
    listApps,
  };
})();
`;
}
