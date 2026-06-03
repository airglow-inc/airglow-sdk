import { logger } from '../lib/logger';
const log = (msg: string) => logger.info('airglow', msg);
import { handleAirglowMessage, setAppManifests, getAppManifests, setOnAppLog } from '../lib/airglow-message-handler';
import { loadAppManifests, registerAllUserscripts, runStartupScripts, cleanupDevSecrets } from '../lib/app-loader';
import { runtimeConfig } from '../lib/runtime-config';
import { trackInstalled } from '../lib/analytics';
import { USER_EMAIL_KEY, normalizeUserEmail } from '../lib/airglow-identity';

export default defineBackground(() => {
  log('service worker started');


  // ───── Iframe CSP bypass (airglow.platform.allowIframes) ─────
  const IFRAME_RULES_KEY = '__platform:iframeAllow';
  const IFRAME_RULE_BASE_ID = 9900; // IDs 9900–9999 reserved for iframe rules

  async function syncIframeRules() {
    const result = await chrome.storage.local.get(IFRAME_RULES_KEY);
    const allApps = (result[IFRAME_RULES_KEY] || {}) as Record<string, { domains: string[]; initiators: string[] }>;
    // Collect all rules across apps
    const removeIds = Array.from({ length: 100 }, (_, i) => IFRAME_RULE_BASE_ID + i);
    const addRules: any[] = [];
    let ruleId = IFRAME_RULE_BASE_ID;
    for (const appId of Object.keys(allApps)) {
      const { domains, initiators } = allApps[appId];
      for (const domain of domains) {
        if (ruleId > 9999) break;
        addRules.push({
          id: ruleId++,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'content-security-policy', operation: 'remove' },
              { header: 'x-frame-options', operation: 'remove' },
            ],
            requestHeaders: [
              { header: 'Sec-Fetch-Dest', operation: 'set', value: 'document' },
            ],
          },
          condition: {
            urlFilter: `||${domain}`,
            resourceTypes: ['sub_frame', 'main_frame'],
            ...(initiators.length > 0 ? { initiatorDomains: initiators } : {}),
          },
        });
      }
    }
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules });
    log(`synced ${addRules.length} iframe CSP bypass rule(s)`);
  }

  // Sync on startup and when storage changes
  syncIframeRules().catch((e: any) => logger.error('airglow', 'iframe rules sync failed: ' + e.message));
  chrome.storage.local.onChanged.addListener((changes) => {
    if (IFRAME_RULES_KEY in changes) syncIframeRules();
  });

  // ───── Airglow app platform ─────
  const lastAppHashes = new Map<string, string>(); // appId → _hash
  let loadGeneration = 0; // bumped on each call; stale runs abort before registering

  async function getDisabledApps(): Promise<Set<string>> {
    return new Promise((resolve) => {
      chrome.storage.local.get('__disabled_apps', (result) => {
        resolve(new Set((result['__disabled_apps'] || []) as string[]));
      });
    });
  }

  // Reflect attention-required state via the toolbar badge.
  // Three conditions raise the badge: dev server offline, user email not set,
  // or the chrome.userScripts API is not allowed (toggle off on chrome://extensions).
  // (dashboard reads + subscribes to the dev-server flag to render its offline state.)
  const DEV_SERVER_ONLINE_KEY = '__dev_server_online';
  let devServerOnline = true;
  let userEmailSet = false;
  let userScriptsAllowed = true;

  function refreshActionBadge() {
    const issues: string[] = [];
    if (!devServerOnline) issues.push('dev server offline');
    if (!userEmailSet) issues.push('email not set');
    if (!userScriptsAllowed) issues.push('user scripts disabled');

    if (issues.length === 0) {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: 'Airglow' });
      return;
    }
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    try { chrome.action.setBadgeTextColor?.({ color: '#ffffff' }); } catch {}
    chrome.action.setTitle({ title: `Airglow — ${issues.join(', ')}` });
  }

  async function setDevServerOnline(online: boolean) {
    await chrome.storage.local.set({ [DEV_SERVER_ONLINE_KEY]: online });
    devServerOnline = online;
    refreshActionBadge();
  }

  // chrome.userScripts.getScripts() throws if the user-scripts toggle is off
  // on chrome://extensions. There's no event for this toggle, so we re-check
  // on each manifest poll (cheap call). Chrome 138+ evaluates chrome.userScripts
  // dynamically at access time, so toggling the permission on/off is observed
  // by the SW on the next poll without needing an extension reload.
  // Returns true if the toggle just transitioned off → on.
  async function refreshUserScriptsAllowed(): Promise<boolean> {
    let allowed = false;
    try {
      if (chrome.userScripts) {
        await chrome.userScripts.getScripts();
        allowed = true;
      }
    } catch {
      allowed = false;
    }
    const justEnabled = allowed && !userScriptsAllowed;
    if (allowed !== userScriptsAllowed) {
      userScriptsAllowed = allowed;
      refreshActionBadge();
    }
    return justEnabled;
  }

  // Seed email state on boot and keep it in sync with chrome.storage changes.
  // In dev builds, runtimeConfig.devUserEmail auto-seeds the email so apps
  // don't trip the email-required gate during local development.
  chrome.storage.local.get(USER_EMAIL_KEY, async (result) => {
    let stored = normalizeUserEmail(result[USER_EMAIL_KEY]);
    if (!stored && runtimeConfig.devUserEmail) {
      const dev = normalizeUserEmail(runtimeConfig.devUserEmail);
      if (dev) {
        await chrome.storage.local.set({ [USER_EMAIL_KEY]: dev });
        stored = dev;
        log(`dev auto-set user email: ${dev}`);
      }
    }
    userEmailSet = !!stored;
    refreshActionBadge();
  });
  chrome.storage.local.onChanged.addListener((changes) => {
    if (USER_EMAIL_KEY in changes) {
      userEmailSet = !!normalizeUserEmail(changes[USER_EMAIL_KEY].newValue);
      refreshActionBadge();
    }
  });

  async function loadAndRegisterApps(force = false, skipReload = false) {
    const gen = ++loadGeneration;
    // If the user just flipped "Allow User Scripts" on, force re-registration:
    // chrome.userScripts works again, but the per-app hash gate below would
    // otherwise skip re-running registerAllUserscripts and leave userscripts
    // un-injected until the user touches a manifest or reloads the extension.
    const justEnabled = await refreshUserScriptsAllowed();
    if (justEnabled) {
      log('user scripts toggle enabled — forcing re-registration');
      force = true;
    }
    const { reachable, manifests: allManifests } = await loadAppManifests();

    await setDevServerOnline(reachable);

    // Detect local dev server going offline → clean up dev secrets
    // Also cleans up on first poll after extension restart if server is down
    if (!reachable) {
      await cleanupDevSecrets(); // no-op if nothing to clean
      lastAppHashes.clear(); // force re-registration when server comes back
      return;
    }

    const disabled = await getDisabledApps();
    const manifests = allManifests.filter(m => !disabled.has(m.id));

    // Keep full list in message handler (for dashboard queries etc.)
    setAppManifests(allManifests);

    // Detect which apps changed (by per-app _hash from dev server). lastAppHashes
    // is our record of what Chrome has actually registered, so the writes are
    // deferred until registration succeeds — otherwise a thrown register call
    // would leave us optimistically marked as registered and we would never retry.
    const pendingHashUpdates: [string, string][] = [];
    const changedApps: string[] = [];
    const currentIds = new Set(manifests.map(m => m.id));
    for (const m of manifests) {
      const hash = (m as any)._hash || m.version;
      const prev = lastAppHashes.get(m.id);
      if (prev !== hash) {
        changedApps.push(m.id);
        pendingHashUpdates.push([m.id, hash]);
      }
    }
    // Detect removed apps — deletion from lastAppHashes is also deferred to
    // post-success for the same reason.
    const removedIds: string[] = [];
    for (const id of lastAppHashes.keys()) {
      if (!currentIds.has(id)) removedIds.push(id);
    }
    const appsRemoved = removedIds.length > 0;

    if (!force && !appsRemoved && changedApps.length === 0) return;

    // Abort if a newer call started while we were loading manifests / checking hashes
    if (gen !== loadGeneration) return;

    // Don't attempt registration while chrome.userScripts is unavailable — it
    // would throw every poll. refreshUserScriptsAllowed will set justEnabled
    // when the user enables it and we'll retry then.
    if (!userScriptsAllowed) return;

    const reloadedIds = force ? manifests.map(m => m.id) : changedApps;
    log(`reloading apps: ${reloadedIds.join(', ')}`);

    // Register userscripts first (critical path — must not be blocked by startup scripts)
    try {
      await registerAllUserscripts(manifests, force ? undefined : changedApps, { skipReload });
      for (const [id, hash] of pendingHashUpdates) lastAppHashes.set(id, hash);
      for (const id of removedIds) lastAppHashes.delete(id);
    } catch (e) {
      logger.error('airglow', `userscript registration failed: ${e}`);
    }

    // Run startup scripts after registration (non-blocking for page injection)
    const startupManifests = force ? manifests : manifests.filter(m => changedApps.includes(m.id));
    runStartupScripts(startupManifests).catch((e) =>
      logger.error('airglow', `startup scripts failed: ${e}`)
    );
  }

  let localManifestTimer: ReturnType<typeof setInterval> | undefined;

  function scheduleLocalManifestPolling() {
    if (localManifestTimer) clearInterval(localManifestTimer);
    localManifestTimer = undefined;
    if (runtimeConfig.localManifestPollMs <= 0) return;
    localManifestTimer = setInterval(() => {
      loadAndRegisterApps().catch((e) =>
        logger.error('airglow', `local app refresh failed: ${e}`)
      );
    }, runtimeConfig.localManifestPollMs);
  }

  loadAndRegisterApps(true).catch((e) => logger.error('airglow', `initial app load failed: ${e}`));
  scheduleLocalManifestPolling();

  // ───── Native messaging bridge for the network trace ─────
  const NM_HOST = 'com.airglow.trace';
  const spiedTabs = new Set<number>();
  let nmPort: chrome.runtime.Port | null = null;
  // Track connection state across reconnect attempts so we log transitions only,
  // not every retry (which floods logs every 3s when the host isn't installed).
  let nmWasConnected = false;
  // Mirror connection state to storage so the dashboard can surface a warning
  // when the debug bridge is down (parallel to __dev_server_online). Key absent
  // = native host disabled for this build; present = enabled, value is liveness.
  const NATIVE_HOST_CONNECTED_KEY = '__native_host_connected';
  function setNativeHostConnected(connected: boolean) {
    chrome.storage.local.set({ [NATIVE_HOST_CONNECTED_KEY]: connected });
  }

  function connectNativeHost() {
    try {
      nmPort = chrome.runtime.connectNative(NM_HOST);
      nmPort.onMessage.addListener((msg) => {
        if (!nmWasConnected) {
          nmWasConnected = true;
          log(`native host connected: ${NM_HOST}`);
          setNativeHostConnected(true);
        }
        onNativeMessage(msg);
      });
      nmPort.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message || 'disconnected';
        if (nmWasConnected) {
          nmWasConnected = false;
          log(`native host disconnected: ${err}`);
          setNativeHostConnected(false);
        }
        nmPort = null;
        setTimeout(connectNativeHost, 3000);
      });
    } catch (e) {
      logger.error('airglow', `connectNative failed: ${e}`);
    }
  }

  function sendToHost(payload: Record<string, unknown>) {
    if (!nmPort) return;
    try { nmPort.postMessage(payload); } catch (e) { logger.error('airglow', `postMessage failed: ${e}`); }
  }

  function onNativeMessage(msg: any) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'attach' && typeof msg.tabId === 'number') {
      spiedTabs.add(msg.tabId);
      sendToHost({ type: 'reply', reqId: msg.reqId, payload: { attached: msg.tabId, spiedTabs: [...spiedTabs] } });
      // If the tab is already loaded, inject immediately so existing session is captured.
      injectTrace(msg.tabId).catch(() => {});
    } else if (msg.type === 'detach' && typeof msg.tabId === 'number') {
      spiedTabs.delete(msg.tabId);
      sendToHost({ type: 'reply', reqId: msg.reqId, payload: { detached: msg.tabId, spiedTabs: [...spiedTabs] } });
    } else if (msg.type === 'logs') {
      logger.getAll().then(entries => {
        sendToHost({ type: 'reply', reqId: msg.reqId, payload: { entries } });
      });
    } else if (msg.type === 'reload') {
      log('reload requested via native host');
      chrome.runtime.reload();
    } else if (msg.type === 'ready') {
      log(`native host ready, http on :${msg.httpPort}`);
    } else if (msg.type === 'tabs') {
      chrome.tabs.query({}).then((tabs) => {
        const list = tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
        sendToHost({ type: 'reply', reqId: msg.reqId, payload: { tabs: list } });
      });
    } else if (msg.type === 'getHtml' && typeof msg.tabId === 'number') {
      domGetHtml(msg.tabId, msg.selector, msg.frame).then((payload) => sendToHost({ type: 'reply', reqId: msg.reqId, payload }));
    } else if (msg.type === 'setHtml' && typeof msg.tabId === 'number') {
      domSetHtml(msg.tabId, msg.selector, msg.html, msg.outer, msg.frame).then((payload) => sendToHost({ type: 'reply', reqId: msg.reqId, payload }));
    } else if (msg.type === 'eval' && typeof msg.tabId === 'number') {
      domEval(msg.tabId, msg.code, msg.frame, msg.main).then((payload) => sendToHost({ type: 'reply', reqId: msg.reqId, payload }));
    } else if (msg.type === 'frames' && typeof msg.tabId === 'number') {
      reply(msg, chrome.webNavigation.getAllFrames({ tabId: msg.tabId }).then((fr) => ({
        frames: (fr || []).map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url })),
      })));
    } else if (msg.type === 'newTab') {
      reply(msg, openInDebugGroup(msg.url, msg.active !== false));
    } else if (msg.type === 'navigate' && typeof msg.tabId === 'number') {
      reply(msg, chrome.tabs.update(msg.tabId, { url: msg.url }).then((t) => ({ id: t?.id, url: msg.url })));
    } else if (msg.type === 'reloadTab' && typeof msg.tabId === 'number') {
      reply(msg, chrome.tabs.reload(msg.tabId).then(() => ({ reloaded: msg.tabId })));
    } else if (msg.type === 'closeTab' && typeof msg.tabId === 'number') {
      reply(msg, chrome.tabs.remove(msg.tabId).then(() => ({ closed: msg.tabId })));
    } else if (msg.type === 'capture' && typeof msg.tabId === 'number') {
      reply(msg, captureTab(msg.tabId));
    }
  }

  // Screenshot a tab as JPEG (quality 90 — much smaller than png). captureVisibleTab
  // grabs the active tab of a window AND hangs if that window isn't focused, so we
  // activate the tab and bring its window to the front first. (CDP can capture a
  // background tab without stealing focus; this can't, without the debugger API.)
  async function captureTab(tabId: number) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.windowId == null) return { error: 'no such tab' };
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 });
    return { dataUrl };
  }

  // ───── Agent debug window ─────
  // Tabs opened by `dom open` go into a dedicated, unfocused window so the agent's
  // tabs stay out of the user's working set. We track the window by id (NOT a tab
  // group): Chrome's saved-tab-groups feature relocates a group into the main
  // window within ~1s of creation, which makes a separate group-window impossible.
  // A plain window has no such behavior, so it persists. The id survives SW
  // restarts via storage; a browser restart drops it and we make a new one.
  const DEBUG_WINDOW_KEY = '__debug_window';

  async function getDebugWindow(): Promise<number | null> {
    const r = await chrome.storage.local.get(DEBUG_WINDOW_KEY);
    const id = r[DEBUG_WINDOW_KEY];
    if (typeof id !== 'number') return null;
    try { await chrome.windows.get(id); return id; }
    catch { log(`debug-window: stored window ${id} gone`); return null; }
  }

  async function openInDebugGroup(url: string, active: boolean) {
    const winId = await getDebugWindow();
    if (winId != null) {
      try {
        const tab = await chrome.tabs.create({ windowId: winId, url, active });
        log(`debug-window: added tab ${tab.id} to window ${winId}`);
        return { id: tab.id, url: tab.url, windowId: winId };
      } catch (e: any) { log(`debug-window: add failed (${e?.message}); new window`); }
    }
    const win = await chrome.windows.create({ url, focused: false });
    const tab = win?.tabs?.[0];
    if (!win?.id || !tab?.id) return { error: 'failed to create debug window' };
    await chrome.storage.local.set({ [DEBUG_WINDOW_KEY]: win.id });
    log(`debug-window: new window ${win.id} tab ${tab.id}`);
    return { id: tab.id, url: tab.url, windowId: win.id };
  }

  // Resolve a tab-control promise into a native-host reply, normalizing errors.
  function reply(msg: any, p: Promise<any>) {
    p.then((payload) => sendToHost({ type: 'reply', reqId: msg.reqId, payload }))
      .catch((e) => sendToHost({ type: 'reply', reqId: msg.reqId, payload: { error: String(e?.message || e) } }));
  }

  // ───── DOM read/write via chrome.scripting (no CDP needed) ─────
  // getHtml/setHtml run in the ISOLATED world — the DOM is shared across worlds,
  // so they never touch page CSP. All three accept an optional `frame` (URL
  // substring) to target a child frame instead of the top document — e.g. the
  // app-shell iframe (its URL contains the dev-server origin).
  async function resolveFrameId(tabId: number, frameMatch?: string | null): Promise<number> {
    if (!frameMatch) return 0; // top frame
    const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    const m = frames.find((f) => (f.url || '').includes(frameMatch));
    if (!m) throw new Error(`no frame matches "${frameMatch}" (frames: ${frames.map((f) => f.url).join(' | ')})`);
    return m.frameId;
  }

  async function domGetHtml(tabId: number, selector?: string | null, frame?: string | null) {
    try {
      const frameId = await resolveFrameId(tabId, frame);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (sel: string | null) => {
          const el = sel ? document.querySelector(sel) : document.documentElement;
          if (!el) return { error: `no element matches selector: ${sel}` };
          return { html: (el as Element).outerHTML };
        },
        args: [selector ?? null],
      });
      return res?.result ?? { error: 'no result' };
    } catch (e: any) { return { error: String(e?.message || e) }; }
  }

  async function domSetHtml(tabId: number, selector: string | null, html: string, outer?: boolean, frame?: string | null) {
    try {
      const frameId = await resolveFrameId(tabId, frame);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (sel: string | null, markup: string, asOuter: boolean) => {
          const el = sel ? document.querySelector(sel) : document.body;
          if (!el) return { error: `no element matches selector: ${sel}` };
          if (asOuter) (el as Element).outerHTML = markup; else (el as Element).innerHTML = markup;
          return { ok: true };
        },
        args: [selector ?? null, html, !!outer],
      });
      return res?.result ?? { error: 'no result' };
    } catch (e: any) { return { error: String(e?.message || e) }; }
  }

  // eval runs in a dedicated USER_SCRIPT world. User scripts are exempt from the
  // page's CSP (same mechanism that runs app userscripts on strict-CSP sites), so
  // arbitrary expressions work everywhere — unlike MAIN-world eval, which the page
  // CSP can block. The world's own CSP is set to permit eval; the page's is untouched.
  const EVAL_WORLD_ID = 'airglow-eval';
  let evalWorldReady = false;
  async function ensureEvalWorld() {
    if (evalWorldReady) return;
    await chrome.userScripts.configureWorld({ worldId: EVAL_WORLD_ID, csp: "script-src 'self' 'unsafe-eval'", messaging: false });
    evalWorldReady = true;
  }

  async function domEval(tabId: number, code: string, frame?: string | null, main?: boolean) {
    // Default: run in a USER_SCRIPT world — CSP-exempt, DOM-complete, but its own
    // `window` (page/app globals like window.__test are NOT visible). Pass main=true
    // to run in the page's MAIN world instead: sees page globals, but the page's CSP
    // applies to eval (so it can be blocked on strict-CSP sites).
    //
    // An IIFE expression: userScripts.execute returns the script's completion value
    // (it runs `code` as a script, not a function body — so no top-level `return`).
    // The MAIN-world path wraps the same body in a func instead.
    const body = `(() => { try { const __v = (0, eval)(${JSON.stringify(code)});`
      + ` try { return { value: JSON.parse(JSON.stringify(__v ?? null)) }; } catch { return { value: String(__v) }; }`
      + ` } catch (e) { return { error: String((e && e.message) || e) }; } })()`;
    try {
      const frameId = await resolveFrameId(tabId, frame);
      if (!main && chrome.userScripts?.execute) {
        await ensureEvalWorld();
        const results = await chrome.userScripts.execute({
          target: { tabId, frameIds: [frameId] },
          worldId: EVAL_WORLD_ID,
          injectImmediately: true,
          js: [{ code: body }],
        } as any);
        const r = (results as any)?.[0];
        if (r?.error) return { error: String(r.error?.message || r.error) };
        return r?.result ?? { error: 'no result' };
      }
      // MAIN world (explicit --main, or fallback when userScripts.execute is
      // unavailable): sees page globals; the page CSP can block eval.
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] }, world: 'MAIN' as any,
        func: (src: string) => {
          try {
            const v = (0, eval)(src);
            try { return { value: JSON.parse(JSON.stringify(v ?? null)) }; } catch { return { value: String(v) }; }
          } catch (e: any) { return { error: String((e && e.message) || e) }; }
        },
        args: [code],
      });
      return res?.result ?? { error: 'no result' };
    } catch (e: any) { return { error: String(e?.message || e) }; }
  }

  async function injectTrace(tabId: number) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN' as any,
      injectImmediately: true,
      func: traceMainWorld,
    });
    // ISOLATED bridge — forwards postMessage from MAIN to background via runtime.sendMessage.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      injectImmediately: true,
      func: traceBridge,
    });
  }

  // Runs in the page's MAIN world. Self-contained (no closures) since it's serialized.
  function traceMainWorld() {
    const w = window as any;
    if (w.__airglowTrace) return;
    w.__airglowTrace = true;
    const push = (entry: any) => window.postMessage({ __airglowNet: true, entry }, '*');
    const origFetch = window.fetch;
    // Extract body text from various types (string, Blob, ArrayBuffer, URLSearchParams, Request)
    const extractBody = async (body: any, input: any): Promise<string | null> => {
      if (typeof body === 'string') return body.slice(0, 20000);
      if (body instanceof URLSearchParams) return body.toString().slice(0, 20000);
      if (body instanceof ArrayBuffer) return new TextDecoder().decode(body).slice(0, 20000);
      if (body instanceof Blob) return (await body.text()).slice(0, 20000);
      // If no body in init, try cloning the Request object's body
      if (!body && input instanceof Request) {
        try { return (await input.clone().text()).slice(0, 20000); } catch { return null; }
      }
      return null;
    };
    window.fetch = async function (...args: any[]) {
      const input = args[0], init = args[1] || {};
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init.method || (input && input.method) || 'GET').toUpperCase();
      const reqBodyP = extractBody(init.body, input);
      // Flatten request headers from Headers / object / [k,v][] forms.
      const reqHeaders: Record<string, string> = {};
      const h = init.headers || (input && input.headers);
      if (h && typeof h.forEach === 'function') {
        h.forEach((v: string, k: string) => { reqHeaders[k] = v; });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) reqHeaders[k] = v;
      } else if (h && typeof h === 'object') {
        for (const k of Object.keys(h)) reqHeaders[k] = String(h[k]);
      }
      const started = Date.now();
      const reqBody = await reqBodyP;
      const res = await origFetch.apply(this, args as any);
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });
      const clone = res.clone();
      clone.text().then((body) => push({
        url, method, reqBody, reqHeaders,
        status: res.status, resHeaders, resBody: body.slice(0, 20000),
        ts: started, transport: 'fetch',
      })).catch(() => {});
      return res;
    };
    const OrigOpen = XMLHttpRequest.prototype.open;
    const OrigSend = XMLHttpRequest.prototype.send;
    const OrigSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m: string, u: string) {
      (this as any).__url = u; (this as any).__method = m;
      (this as any).__reqHeaders = {};
      return OrigOpen.apply(this, arguments as any);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k: string, v: string) {
      ((this as any).__reqHeaders = (this as any).__reqHeaders || {})[k] = v;
      return OrigSetHeader.apply(this, arguments as any);
    };
    XMLHttpRequest.prototype.send = function (body: any) {
      const started = Date.now();
      this.addEventListener('load', () => {
        const resHeaders: Record<string, string> = {};
        try {
          const raw = this.getAllResponseHeaders();
          raw.split(/\r?\n/).forEach((line) => {
            const i = line.indexOf(':');
            if (i > 0) resHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
          });
        } catch {}
        push({
          url: (this as any).__url,
          method: ((this as any).__method || 'GET').toUpperCase(),
          reqBody: typeof body === 'string' ? body.slice(0, 20000) : null,
          reqHeaders: (this as any).__reqHeaders || {},
          status: this.status,
          resHeaders,
          resBody: typeof this.responseText === 'string' ? this.responseText.slice(0, 20000) : null,
          ts: started, transport: 'xhr',
        });
      });
      return OrigSend.apply(this, arguments as any);
    };
  }

  // Runs in ISOLATED world. Bridges window.postMessage → runtime.sendMessage.
  function traceBridge() {
    const w = window as any;
    if (w.__airglowTraceBridge) return;
    w.__airglowTraceBridge = true;
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || !d.__airglowNet || !d.entry) return;
      try { chrome.runtime.sendMessage({ type: 'airglow:net-capture', entry: d.entry }); } catch {}
    });
  }

  if (runtimeConfig.enableNativeHost) {
    setNativeHostConnected(false); // seed: dashboard shows "Disconnected" until the host replies
    connectNativeHost();
  } else {
    chrome.storage.local.remove(NATIVE_HOST_CONNECTED_KEY); // hide the indicator entirely
    log('native host disabled for this build profile');
  }



  // ───── Platform redirects (storage-backed, registered by apps via startup.ts) ─────
  const REDIRECTS_KEY = '__platform:redirects';
  let redirectRules: { appId: string; domains: string[]; target: string }[] = [];

  function loadRedirectRules() {
    chrome.storage.local.get([REDIRECTS_KEY, '__disabled_apps'], (result) => {
      const all = (result[REDIRECTS_KEY] || {}) as Record<string, { domains: string[]; target: string }[]>;
      const disabled = new Set((result['__disabled_apps'] || []) as string[]);
      redirectRules = [];
      for (const [appId, rules] of Object.entries(all)) {
        if (disabled.has(appId)) continue;
        for (const rule of rules) {
          redirectRules.push({ appId, domains: rule.domains, target: rule.target });
        }
      }
      if (redirectRules.length > 0) {
        log(`loaded ${redirectRules.length} redirect rule(s)`);
      }
    });
  }
  loadRedirectRules();
  // Reload rules when apps register/update redirects or apps are disabled
  chrome.storage.local.onChanged.addListener((changes) => {
    if (REDIRECTS_KEY in changes || '__disabled_apps' in changes) loadRedirectRules();
  });

  function matchRedirect(hostname: string): { appId: string; domain: string; target: string } | undefined {
    const parts = hostname.split('.');
    for (const rule of redirectRules) {
      for (let i = 0; i < parts.length - 1; i++) {
        const candidate = parts.slice(i).join('.');
        if (rule.domains.includes(candidate)) {
          return { appId: rule.appId, domain: candidate, target: rule.target };
        }
      }
    }
  }

  // Use onCommitted to catch the final URL after HTTP redirects (e.g. youtu.be → youtube.com)
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return; // main frame only
    try {
      const url = new URL(details.url);
      const match = matchRedirect(url.hostname);
      if (match) {
        const appId = match.target.replace('airglow://', '');
        chrome.tabs.update(details.tabId, {
          url: chrome.runtime.getURL(`app-shell.html?app=${appId}&site=${match.domain}`),
        });
        return;
      }
      // Trace injection: only for tabs Claude has attached via native host.
      if (spiedTabs.has(details.tabId)) {
        injectTrace(details.tabId).catch((e) => logger.error('airglow', `trace inject failed: ${e}`));
      }
    } catch {}
  });



  // Open dashboard on first install
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      trackInstalled().catch((e) =>
        logger.warn('airglow', `trackInstalled failed: ${e instanceof Error ? e.message : String(e)}`)
      );
    }
  });

  // Idempotent retry on every service-worker spin-up — the ping is dedup'd via
  // chrome.storage, so this just covers the case where the install fire missed
  // the network (offline backend, race with first app source discovery).
  trackInstalled().catch(() => {});

  // If the extension was reloaded via our own UI ("Reload Airglow" button), reopen/refocus the dashboard.
  const REOPEN_DASHBOARD_KEY = '__reopen_dashboard_after_reload';
  chrome.storage.local.get(REOPEN_DASHBOARD_KEY, (result) => {
    if (!result[REOPEN_DASHBOARD_KEY]) return;
    chrome.storage.local.remove(REOPEN_DASHBOARD_KEY);
    const dashboardUrl = chrome.runtime.getURL('dashboard.html');
    chrome.tabs.query({ url: dashboardUrl + '*' }, (tabs) => {
      const existing = tabs[0];
      if (existing?.id !== undefined) {
        chrome.tabs.reload(existing.id);
        chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId !== undefined) chrome.windows.update(existing.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: dashboardUrl });
      }
    });
  });

  // Extension icon click → open dashboard
  chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });

  // ── Per-tab error tracking (in-memory, for edge button indicators) ──
  const tabErrors = new Map<number, Set<string>>(); // tabId → set of appIds with errors

  // Track errors only after the message handler validates and persists the log.
  // This prevents the indicator from showing when the log was rejected (stale secret, etc.).
  setOnAppLog((appId, level, sender) => {
    if (level !== 'error' && level !== 'warn') return;
    const tabId = sender?.tab?.id;
    if (!tabId) return;
    if (!tabErrors.has(tabId)) tabErrors.set(tabId, new Set());
    tabErrors.get(tabId)!.add(appId);
  });

  // Clean up when tabs close
  chrome.tabs.onRemoved.addListener((tabId) => { tabErrors.delete(tabId); });

  // Relay messages between content scripts and popup/server
  // ── Airglow SDK messages from USER_SCRIPT world ──
  chrome.runtime.onUserScriptMessage.addListener((msg: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    return handleAirglowMessage(msg, sender, sendResponse);
  });

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // ── Airglow SDK messages (from content scripts/UI/startup) ──
    if (handleAirglowMessage(msg, _sender as chrome.runtime.MessageSender, sendResponse)) return true;

    // ── Edge button ──
    if (msg?.type === 'airglow:open-dashboard') {
      const page = msg.page ? `?page=${msg.page}` : '';
      chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${page}`) });
      return;
    }

    if (msg?.type === 'airglow:open-app') {
      chrome.tabs.create({ url: chrome.runtime.getURL(`app-shell.html?app=${msg.appId}`) });
      return;
    }

    // ── Dashboard actions ──
    if (msg?.type === 'airglow:reload-apps') {
      loadAndRegisterApps(true).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
      return true;
    }

    if (msg?.type === 'airglow:reload-app') {
      // Force reload a single app
      const appId = msg.appId;
      lastAppHashes.delete(appId);
      loadAndRegisterApps().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
      return true;
    }

    if (msg?.type === 'airglow:toggle-app') {
      const appId = msg.appId;
      getDisabledApps().then(async (disabled) => {
        const wasDisabled = disabled.has(appId);
        if (wasDisabled) disabled.delete(appId);
        else disabled.add(appId);
        await chrome.storage.local.set({ '__disabled_apps': Array.from(disabled) });
        lastAppHashes.delete(appId);
        // force=true to bypass change detection — disabled set changed, must re-register
        // skipReload=true — user refreshes manually via edge panel button
        await loadAndRegisterApps(true, true);
        sendResponse({ ok: true, disabled: !wasDisabled });
      }).catch(e => sendResponse({ error: e.message }));
      return true;
    }

    if (msg?.type === 'airglow:get-page-apps') {
      // Return apps matching a given URL (or a specific appId for app-shell), with disabled status
      const url = msg.url as string;
      const appId = msg.appId as string | undefined;
      const senderTabId = _sender?.tab?.id;
      const errorsOnTab = senderTabId ? tabErrors.get(senderTabId) : undefined;
      const allManifests = getAppManifests();
      getDisabledApps().then((disabled) => {
        const matching: { id: string; name: string; disabled: boolean; hasError?: boolean }[] = [];
        const seen = new Set<string>();

        // If appId is specified (app-shell), return just that app
        if (appId) {
          const m = allManifests.find(m => m.id === appId);
          if (m) matching.push({ id: m.id, name: m.name, disabled: disabled.has(m.id), hasError: errorsOnTab?.has(m.id) });
          sendResponse({ apps: matching });
          return;
        }

        // Check userscript matches
        for (const m of allManifests) {
          if (m.userscripts?.some(us =>
            us.matches.some(p => {
              const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
              return re.test(url);
            })
          )) {
            seen.add(m.id);
            matching.push({ id: m.id, name: m.name, disabled: disabled.has(m.id), hasError: errorsOnTab?.has(m.id) });
          }
        }

        // Check redirect domains
        try {
          const hostname = new URL(url).hostname;
          for (const rule of redirectRules) {
            if (seen.has(rule.appId)) continue;
            const parts = hostname.split('.');
            for (let i = 0; i < parts.length - 1; i++) {
              if (rule.domains.includes(parts.slice(i).join('.'))) {
                const m = allManifests.find(m => m.id === rule.appId);
                if (m) {
                  seen.add(m.id);
                  matching.push({ id: m.id, name: m.name, disabled: disabled.has(m.id), hasError: errorsOnTab?.has(m.id) });
                }
                break;
              }
            }
          }
        } catch {}

        // Also check disabled apps' redirect rules (they're excluded from redirectRules)
        chrome.storage.local.get('__platform:redirects', (result) => {
          const all = (result['__platform:redirects'] || {}) as Record<string, { domains: string[]; target: string }[]>;
          try {
            const hostname = new URL(url).hostname;
            for (const [rAppId, rules] of Object.entries(all)) {
              if (seen.has(rAppId)) continue;
              for (const rule of rules) {
                const parts = hostname.split('.');
                for (let i = 0; i < parts.length - 1; i++) {
                  if (rule.domains.includes(parts.slice(i).join('.'))) {
                    const m = allManifests.find(m => m.id === rAppId);
                    if (m) {
                      seen.add(m.id);
                      matching.push({ id: m.id, name: m.name, disabled: disabled.has(m.id), hasError: errorsOnTab?.has(m.id) });
                    }
                    break;
                  }
                }
              }
            }
          } catch {}
          sendResponse({ apps: matching });
        });
      });
      return true;
    }

    if (msg?.type === 'airglow:clear-app-storage') {
      const prefix = `airglow:app:${msg.appId}:`;
      chrome.storage.local.get(null, (all) => {
        const keysToRemove = Object.keys(all).filter(k => k.startsWith(prefix));
        chrome.storage.local.remove(keysToRemove, () => {
          sendResponse({ ok: true, removed: keysToRemove.length });
        });
      });
      return true;
    }

    if (msg?.type === 'airglow:secrets:get-all') {
      chrome.storage.local.get(null, (all) => {
        const userSecrets: Record<string, string> = {};
        const devSecrets: Record<string, string> = {};
        for (const [k, v] of Object.entries(all)) {
          if (k.startsWith('airglow:secret:')) userSecrets[k.slice('airglow:secret:'.length)] = v as string;
          if (k.startsWith('airglow:dev-secret:')) devSecrets[k.slice('airglow:dev-secret:'.length)] = v as string;
        }
        sendResponse({ userSecrets, devSecrets });
      });
      return true;
    }

    if (msg?.type === 'airglow:secrets:save') {
      const entries: Record<string, string> = {};
      const toDelete: string[] = [];
      // msg.secrets: Record<string, string> — empty string means delete
      for (const [key, value] of Object.entries(msg.secrets as Record<string, string>)) {
        if (value) {
          entries[`airglow:secret:${key}`] = value;
        } else {
          toDelete.push(`airglow:secret:${key}`);
        }
      }
      const ops: Promise<void>[] = [];
      if (Object.keys(entries).length > 0) ops.push(chrome.storage.local.set(entries));
      if (toDelete.length > 0) ops.push(chrome.storage.local.remove(toDelete));
      Promise.all(ops).then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg?.type === 'airglow:get-manifests') {
      sendResponse({ manifests: getAppManifests() });
      return true;
    }

    if (msg?.type === 'airglow:logs:get') {
      logger.getAll().then(entries => sendResponse({ entries }));
      return true;
    }

    if (msg?.type === 'airglow:logs:clear') {
      logger.clear().then(() => sendResponse({ ok: true }));
      return true;
    }


    // Trace capture: content script bridge → native host
    if (msg?.type === 'airglow:net-capture') {
      const tabId = _sender?.tab?.id;
      if (tabId != null && spiedTabs.has(tabId)) {
        sendToHost({ type: 'capture', entry: { tabId, ...msg.entry } });
      }
      return false;
    }

    // ── Generic proxy fetch for content scripts (avoids CORS) ──
    if (msg?.type === 'airglow:proxy-fetch') {
      fetch(msg.url, {
        method: msg.method || 'GET',
        headers: msg.headers,
        body: msg.body,
      })
        .then(async (res) => {
          const text = await res.text();
          let body;
          try { body = JSON.parse(text); } catch { body = text; }
          sendResponse({ status: res.status, body });
        })
        .catch((e) => sendResponse({ error: e.message }));
      return true;
    }

  });
});
