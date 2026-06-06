import { logger } from '../lib/logger';
const log = (msg: string) => logger.info('airglow', msg);
import { handleAirglowMessage, setAppManifests, getAppManifests, setOnAppLog } from '../lib/airglow-message-handler';
import { APP_INVENTORY_MANIFESTS_KEY, loadAppManifests, registerAllUserscripts, runStartupScripts, cleanupDevSecrets, type AppManifest, type AppSourceOverrides, type SourcedManifest } from '../lib/app-loader';
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
  // Inventory list (both copies of an app that exists in local + cloud sources).
  // Runtime list dedupes local-wins; the dashboard wants to surface both.
  let dashboardAppManifests: SourcedManifest[] = [];

  async function getDisabledApps(): Promise<Set<string>> {
    return new Promise((resolve) => {
      chrome.storage.local.get('__disabled_apps', (result) => {
        resolve(new Set((result['__disabled_apps'] || []) as string[]));
      });
    });
  }

  // __seen_apps records every app id we've ever loaded, so the
  // manifest.defaultEnabled hint is applied exactly once per id. After first
  // encounter, the user's __disabled_apps toggle is authoritative — the
  // manifest field is ignored, so toggling a defaultEnabled:false app on in
  // the dashboard sticks across dev-server restarts.
  const SEEN_APPS_KEY = '__seen_apps';
  const APP_SOURCE_OVERRIDE_KEY = '__app_source_override';

  // Migration path: when SEEN_APPS_KEY is missing (pre-feature install) but
  // __app_manifests already has entries, seed seen with those ids without
  // changing __disabled_apps. Without this, an existing user upgrading would
  // suddenly see all defaultEnabled:false apps flip off, overriding any
  // previous Enable toggles they made.
  async function applyFirstEncounterDefaults(
    manifests: AppManifest[],
    isMigration: boolean,
    priorManifests: AppManifest[],
  ): Promise<void> {
    const stored = await chrome.storage.local.get([SEEN_APPS_KEY, '__disabled_apps']);
    const seen = new Set<string>((stored[SEEN_APPS_KEY] || []) as string[]);
    const disabled = new Set<string>((stored['__disabled_apps'] || []) as string[]);
    let changed = false;

    if (isMigration) {
      for (const m of priorManifests) {
        if (!seen.has(m.id)) { seen.add(m.id); changed = true; }
      }
    }

    for (const m of manifests) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      changed = true;
      if (m.defaultEnabled === false && !disabled.has(m.id)) disabled.add(m.id);
    }

    if (!changed) return;
    await chrome.storage.local.set({
      [SEEN_APPS_KEY]: Array.from(seen),
      '__disabled_apps': Array.from(disabled),
    });
  }

  // Reflect attention-required state via the toolbar badge.
  // Dev-server offline is intentionally excluded — it's not user-actionable and the
  // dashboard surfaces it instead. (dashboard still reads + subscribes to the flag.)
  const DEV_SERVER_ONLINE_KEY = '__dev_server_online';
  let userScriptsAllowed = true;
  let extensionReloadDue = false;
  // gitPullDue has two independent sources: the dev server (commit-accurate but
  // requires server running) and a direct GitHub raw-manifest fetch (catches
  // extension-source/ changes only, but works with no server). Either source
  // raising the flag is enough to show the badge.
  let gitPullDueServer = false;
  let gitPullDueRemote = false;

  function refreshActionBadge() {
    const issues: string[] = [];
    if (!userScriptsAllowed) issues.push('user scripts disabled');
    if (extensionReloadDue) issues.push('extension reload available');
    if (gitPullDueServer || gitPullDueRemote) issues.push('newer SDK on origin — git pull');

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
    if (!online) {
      // Server went away — clear server-derived flags so they aren't stuck on
      // if the user happens to launch a different workspace later. The
      // remote-manifest check is independent of the dev server, so its flag
      // (gitPullDueRemote) is preserved.
      extensionReloadDue = false;
      gitPullDueServer = false;
    }
    refreshActionBadge();
  }

  // Polls the dev server's update-status endpoint for two signals:
  //   - extension.needsReload: loaded build hash != extension/ on disk
  //   - repo.behindUpstream:   local HEAD != upstream HEAD (cached 1h server-side)
  // Piggybacks on the manifest poll cycle (called from loadAndRegisterApps when
  // the server is reachable).
  async function refreshUpdateStatus() {
    try {
      const port = await new Promise<number>((resolve) => {
        chrome.storage.local.get('__dev_port', (r) => resolve((r['__dev_port'] as number) || 3222));
      });
      const loadedHash = (chrome.runtime.getManifest() as { airglow_build_hash?: string }).airglow_build_hash || '';
      const qs = loadedHash ? `?extensionBuildHash=${encodeURIComponent(loadedHash)}` : '';
      const res = await fetch(`http://127.0.0.1:${port}/api/extension/update-status${qs}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return;
      const data: any = await res.json();
      const nextReload = !!data?.extension?.needsReload;
      const nextPull = !!data?.repo?.behindUpstream;
      if (nextReload !== extensionReloadDue || nextPull !== gitPullDueServer) {
        extensionReloadDue = nextReload;
        gitPullDueServer = nextPull;
        refreshActionBadge();
      }
    } catch { /* transient — next tick retries */ }
  }

  // Independent of the dev server: hit origin/main's extension/manifest.json
  // directly and compare its airglow_build_ts (build time, baked in by
  // export-extension.sh) to the loaded one. Only prompts "git pull" when
  // remote is *strictly later* than local — hash diffs alone aren't enough
  // because they fire when local is ahead too (rebuild on a feature branch).
  // Wakes the SW on a chrome.alarms schedule so it keeps checking even when
  // the user isn't actively interacting with the extension and the dev server
  // is offline. Caveat: only detects changes to extension/manifest.json's
  // build stamp. CLI-only / docs-only commits won't trip this.
  const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/airglow-inc/airglow-sdk/main/extension/manifest.json';
  const REMOTE_CHECK_ALARM = 'airglow:remote-update-check';

  // Persisted so the dashboard can render the "git pull" banner in sync with
  // the toolbar badge — the badge fires on (server-side OR remote-only)
  // signal, but the dashboard previously only saw the server-side one.
  const GIT_PULL_DUE_REMOTE_KEY = '__git_pull_due_remote';

  async function refreshRemoteUpdateStatus() {
    try {
      const res = await fetch(REMOTE_MANIFEST_URL, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
      if (!res.ok) return;
      const remote: any = await res.json();
      const remoteTs = typeof remote?.airglow_build_ts === 'number' ? remote.airglow_build_ts : 0;
      const loadedTs = (chrome.runtime.getManifest() as { airglow_build_ts?: number }).airglow_build_ts || 0;
      // Strictly later → pull. Older/equal → silent (local rebuild or
      // already up-to-date). Missing timestamp on either side → silent so
      // older builds don't pester after upgrading.
      const next = !!(remoteTs && loadedTs && remoteTs > loadedTs);
      if (next !== gitPullDueRemote) {
        gitPullDueRemote = next;
        await chrome.storage.local.set({ [GIT_PULL_DUE_REMOTE_KEY]: next });
        refreshActionBadge();
      }
    } catch { /* network blip — try again next alarm */ }
  }

  // Register the alarm only if one isn't already scheduled — every SW boot
  // re-runs this body, and re-creating an alarm with the same name resets its
  // schedule, so without the guard a frequently-restarting SW would push the
  // next fire forever.
  chrome.alarms.get(REMOTE_CHECK_ALARM).then((existing) => {
    if (!existing) chrome.alarms.create(REMOTE_CHECK_ALARM, { periodInMinutes: 60 });
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REMOTE_CHECK_ALARM) refreshRemoteUpdateStatus();
  });
  // Seed from the last persisted value so the badge survives SW restarts
  // without waiting for the network check to come back.
  chrome.storage.local.get(GIT_PULL_DUE_REMOTE_KEY).then((r) => {
    const v = !!r[GIT_PULL_DUE_REMOTE_KEY];
    if (v !== gitPullDueRemote) {
      gitPullDueRemote = v;
      refreshActionBadge();
    }
  });
  // Also run once at SW startup so the badge reflects current state without
  // waiting for the first alarm fire (which could be up to an hour away).
  refreshRemoteUpdateStatus();

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
  // `__airglow_skip_dev_seed` opts a profile out of that — used by
  // `pnpm chrome --ask-email` to test the email-onboarding flow.
  chrome.storage.local.get([USER_EMAIL_KEY, '__airglow_skip_dev_seed'], async (result) => {
    let stored = normalizeUserEmail(result[USER_EMAIL_KEY]);
    const skipDevSeed = result['__airglow_skip_dev_seed'] === true;
    if (!stored && runtimeConfig.devUserEmail && !skipDevSeed) {
      const dev = normalizeUserEmail(runtimeConfig.devUserEmail);
      if (dev) {
        await chrome.storage.local.set({ [USER_EMAIL_KEY]: dev });
        log(`dev auto-set user email: ${dev}`);
      }
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
    // Snapshot prior state BEFORE loadAppManifests overwrites __app_manifests —
    // applyFirstEncounterDefaults needs the previous manifest set to migrate
    // existing installs (see SEEN_APPS_KEY comment).
    const prior = await chrome.storage.local.get([SEEN_APPS_KEY, '__app_manifests']);
    const isSeenMigration = prior[SEEN_APPS_KEY] === undefined;
    const priorManifests = (prior['__app_manifests'] as AppManifest[] | undefined) || [];

    // Per-appId source override: when a cloud app is shadowed by a local copy,
    // the user can click "Use cloud version" → cloud takes the runtime slot.
    const overridesRes = await chrome.storage.local.get(APP_SOURCE_OVERRIDE_KEY);
    const sourceOverrides = (overridesRes[APP_SOURCE_OVERRIDE_KEY] as AppSourceOverrides | undefined) || {};
    const { reachable, localReachable, usedCachedLocalManifests, manifests: allManifests, inventoryManifests } = await loadAppManifests(sourceOverrides);

    await setDevServerOnline(localReachable);
    if (localReachable) refreshUpdateStatus();

    // Local dev server going offline → clean up dev secrets so they don't
    // linger from a previous workspace we no longer talk to. Cached-local
    // replay still counts as offline for this purpose.
    if (!localReachable) {
      await cleanupDevSecrets();
    }

    // Nothing from any source — clear in-memory + early-exit. The handler's
    // own hydrate-from-storage fallback handles the SW-restart race.
    if (!reachable) {
      lastAppHashes.clear();
      dashboardAppManifests = [];
      setAppManifests([]);
      return;
    }

    // Cached-local replay (dev server briefly offline, cloud may still be
    // up): keep userscripts working across SW restarts. Skip housekeeping —
    // no fresh signal to act on.
    if (usedCachedLocalManifests && allManifests.length > 0) {
      dashboardAppManifests = inventoryManifests;
      setAppManifests(allManifests);
      const disabled = await getDisabledApps();
      const manifests = allManifests.filter(m => !disabled.has(m.id));
      try {
        await registerAllUserscripts(manifests, undefined, { skipReload: true });
      } catch (e) {
        logger.error('airglow', `offline userscript registration failed: ${e}`);
      }
      return;
    }

    await applyFirstEncounterDefaults(allManifests, isSeenMigration, priorManifests);

    const disabled = await getDisabledApps();
    const manifests = allManifests.filter(m => !disabled.has(m.id));

    // Keep full list in message handler (for dashboard queries etc.)
    dashboardAppManifests = inventoryManifests;
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

  chrome.storage.local.onChanged.addListener((changes) => {
    if (USER_EMAIL_KEY in changes) {
      loadAndRegisterApps(true, true).catch((e) =>
        logger.error('airglow', `email-scoped app refresh failed: ${e}`)
      );
    }
  });

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
      ensureAgentBanner(msg.tabId);
      domGetHtml(msg.tabId, msg.selector, msg.frame).then((payload) => sendToHost({ type: 'reply', reqId: msg.reqId, payload }));
    } else if (msg.type === 'setHtml' && typeof msg.tabId === 'number') {
      ensureAgentBanner(msg.tabId);
      domSetHtml(msg.tabId, msg.selector, msg.html, msg.outer, msg.frame).then((payload) => sendToHost({ type: 'reply', reqId: msg.reqId, payload }));
    } else if (msg.type === 'eval' && typeof msg.tabId === 'number') {
      ensureAgentBanner(msg.tabId);
      domEval(msg.tabId, msg.code, msg.frame, msg.main).then((payload) => sendToHost({ type: 'reply', reqId: msg.reqId, payload }));
    } else if (msg.type === 'frames' && typeof msg.tabId === 'number') {
      reply(msg, chrome.webNavigation.getAllFrames({ tabId: msg.tabId }).then((fr) => ({
        frames: (fr || []).map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url })),
      })));
    } else if (msg.type === 'newTab') {
      reply(msg, openInDebugGroup(msg.url, msg.active !== false).then((r: any) => {
        if (typeof r?.id === 'number') paintBannerOnNextLoad(r.id);
        return r;
      }));
    } else if (msg.type === 'navigate' && typeof msg.tabId === 'number') {
      paintBannerOnNextLoad(msg.tabId);
      reply(msg, chrome.tabs.update(msg.tabId, { url: msg.url }).then((t) => ({ id: t?.id, url: msg.url })));
    } else if (msg.type === 'reloadTab' && typeof msg.tabId === 'number') {
      paintBannerOnNextLoad(msg.tabId);
      reply(msg, chrome.tabs.reload(msg.tabId).then(() => ({ reloaded: msg.tabId })));
    } else if (msg.type === 'closeTab' && typeof msg.tabId === 'number') {
      reply(msg, chrome.tabs.remove(msg.tabId).then(() => ({ closed: msg.tabId })));
    } else if (msg.type === 'capture' && typeof msg.tabId === 'number') {
      ensureAgentBanner(msg.tabId);
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

  // ───── "Airglow is using this tab" banner ─────
  // Injected each time the host drives a tab through chrome.scripting (idempotent
  // via id check). User can dismiss with the × (persisted per-tab via
  // sessionStorage; cleared on cross-origin nav). The banner is intentionally
  // tied to *current* activity: it disappears with the next page navigation and
  // only reappears when the agent runs another command. Silently no-ops on
  // unscriptable pages (chrome://, the new-tab page, ...).

  function bannerScript(fontUrl: string) {
    if ((window as any).sessionStorage.getItem('__airglow_using_tab_dismissed') === '1') return;
    if (document.getElementById('__airglow_using_tab')) return;
    if (!document.body) return;
    // Inject @font-face once per page so the banner renders in our bundled Inter
    // regardless of what the page ships. Named 'Airglow Inter' to avoid any
    // collision with a page-loaded 'Inter' face. textContent (not innerHTML) so
    // Trusted Types policies don't intercept.
    const FONT_FAMILY = 'Airglow Inter';
    if (!document.getElementById('__airglow_using_tab_font')) {
      const style = document.createElement('style');
      style.id = '__airglow_using_tab_font';
      style.textContent =
        '@font-face { font-family: "' + FONT_FAMILY + '"; font-style: normal;' +
        ' font-weight: 100 900; font-display: swap;' +
        ' src: url("' + fontUrl + '") format("woff2-variations"); }';
      (document.head || document.documentElement).appendChild(style);
    }
    const el = document.createElement('div');
    el.id = '__airglow_using_tab';
    const FONT = '"' + FONT_FAMILY + '", sans-serif';
    el.style.cssText = [
      'all: initial',
      'position: fixed', 'top: 14px', 'left: 50%', 'transform: translateX(-50%)',
      'z-index: 2147483647',
      'display: inline-flex', 'align-items: center', 'gap: 10px',
      'padding: 10px 14px 10px 20px', 'box-sizing: border-box',
      'border: 2px solid #b8932f', 'border-radius: 9999px',
      'background: #ede1c2', 'color: #232321',
      `font-family: ${FONT}`,
      'font-size: 16px', 'font-weight: 600', 'letter-spacing: -0.012em',
      'white-space: nowrap', 'user-select: none',
      'box-shadow: 0 1px 3px rgba(184,144,50,0.22)',
      '-webkit-font-smoothing: antialiased',
    ].join(';');
    // Airglow logo (matches the gmail-calendar "Create meeting" button in site/mocks).
    // Built via createElementNS rather than innerHTML so sites with Trusted Types
    // policies (e.g. LinkedIn) don't strip it.
    const SVG = 'http://www.w3.org/2000/svg';
    const logo = document.createElementNS(SVG, 'svg');
    logo.setAttribute('xmlns', SVG);
    logo.setAttribute('viewBox', '245 250 520 520');
    logo.setAttribute('width', '20');
    logo.setAttribute('height', '20');
    logo.style.cssText = 'flex-shrink: 0; display: block;';
    const g = document.createElementNS(SVG, 'g');
    g.setAttribute('transform', 'translate(52, 18) scale(0.98)');
    const paths: [string, string, string?][] = [
      ['#1c1917', 'M416.6 246.2 L200.8 753.5 L707.6 753.5 L490.8 246.2 Z'],
      ['#F8BB5B', 'M416.6 246.2 L210.4 731 L313 649.9 L326.7 649.9 L446.9 551.2 L539.7 639.1 L560.2 640.1 L698 731 L490.8 246.2 Z M392.1 543.3 L510.4 543.3 L450.8 382.1 Z', 'evenodd'],
      ['#FB864A', 'M714.632 416.635C701.3 446.692 670.155 464.771 637.443 461.441C604.73 458.111 577.867 434.126 570.866 401.999C563.864 369.872 578.312 336.885 606.672 320.245C635.032 303.605 670.876 307.085 695.506 328.87C709.65 341.38 718.632 358.707 720.703 377.476C720.758 377.977 720.809 378.478 720.854 378.98C722.016 391.856 719.875 404.817 714.632 416.635Z'],
      ['#F99E3D', 'M200.8 753.5 L318.8 753.5 L355 678.2 L393.1 697.8 L448.8 634.2 L473.3 659.6 L468.4 634.2 L475.2 627.4 L446.9 570.7 L334.5 667.5 Z'],
      ['#F99E3D', 'M595.4 753.5 L707.6 753.5 L556.3 669.4 Z'],
    ];
    for (const [fill, d, fillRule] of paths) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('fill', fill);
      p.setAttribute('d', d);
      if (fillRule) p.setAttribute('fill-rule', fillRule);
      g.appendChild(p);
    }
    logo.appendChild(g);
    const label = document.createElement('span');
    label.textContent = 'Airglow is using this tab';
    label.style.cssText = 'all: initial; color: inherit; font: inherit; letter-spacing: inherit;';
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = [
      'all: initial',
      'display: flex', 'align-items: center', 'justify-content: center',
      'width: 28px', 'height: 28px', 'border-radius: 14px',
      'background: transparent',
      'cursor: pointer', 'margin-left: 4px',
    ].join(';');
    // SVG × — perfectly centered (Unicode ×/✕ glyphs sit above the optical
    // center inside their em box, which flex-centering can't fix).
    const cross = document.createElementNS(SVG, 'svg');
    cross.setAttribute('xmlns', SVG);
    cross.setAttribute('viewBox', '0 0 14 14');
    cross.setAttribute('width', '14');
    cross.setAttribute('height', '14');
    cross.style.cssText = 'display: block;';
    for (const [x1, y1, x2, y2] of [[2, 2, 12, 12], [12, 2, 2, 12]] as const) {
      const line = document.createElementNS(SVG, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      line.setAttribute('stroke', '#6b5318');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-linecap', 'round');
      cross.appendChild(line);
    }
    close.appendChild(cross);
    close.addEventListener('mouseenter', () => { close.style.background = 'rgba(184,144,50,0.18)'; });
    close.addEventListener('mouseleave', () => { close.style.background = 'transparent'; });
    close.addEventListener('click', () => {
      try { window.sessionStorage.setItem('__airglow_using_tab_dismissed', '1'); } catch {}
      el.remove();
    });
    el.appendChild(logo);
    el.appendChild(label);
    el.appendChild(close);
    document.body.appendChild(el);
  }

  async function ensureAgentBanner(tabId: number) {
    try {
      const fontUrl = chrome.runtime.getURL('fonts/inter-variable.woff2');
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: bannerScript,
        args: [fontUrl],
      });
    } catch { /* unscriptable page (chrome://, NTP, etc.) — skip silently */ }
  }

  // Paint the banner after an agent-driven navigation completes. Idea: when the
  // agent navigates/reloads/opens a tab, the *next* onCompleted on that tab's
  // top frame is the one we caused — inject the banner there, then remove the
  // listener. 30s leak guard in case the page never loads (we don't want a
  // long-lived listener firing for a future user-initiated nav).
  function paintBannerOnNextLoad(tabId: number) {
    const listener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      chrome.webNavigation.onCompleted.removeListener(listener);
      clearTimeout(timer);
      ensureAgentBanner(tabId);
    };
    const timer = setTimeout(() => chrome.webNavigation.onCompleted.removeListener(listener), 30000);
    chrome.webNavigation.onCompleted.addListener(listener);
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

  setNativeHostConnected(false); // seed: dashboard shows "Disconnected" until the host replies
  connectNativeHost();



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
  // tabId → appId → latest error/warn ts. Compared against __logs_last_seen_ts
  // so the indicator clears once the user reads the logs page.
  const tabErrors = new Map<number, Map<string, number>>();

  // Track errors only after the message handler validates and persists the log.
  // This prevents the indicator from showing when the log was rejected (stale secret, etc.).
  setOnAppLog((appId, level, sender) => {
    if (level !== 'error' && level !== 'warn') return;
    const tabId = sender?.tab?.id;
    if (!tabId) return;
    let m = tabErrors.get(tabId);
    if (!m) { m = new Map(); tabErrors.set(tabId, m); }
    m.set(appId, Date.now());
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

    if (msg?.type === 'airglow:set-source-override') {
      const appId = String(msg.appId || '');
      const sourceType = msg.sourceType as 'local' | 'cloud' | null;
      chrome.storage.local.get(APP_SOURCE_OVERRIDE_KEY).then(async (result) => {
        const overrides = (result[APP_SOURCE_OVERRIDE_KEY] as AppSourceOverrides | undefined) || {};
        if (sourceType === null) {
          delete overrides[appId];
        } else {
          overrides[appId] = sourceType;
        }
        await chrome.storage.local.set({ [APP_SOURCE_OVERRIDE_KEY]: overrides });
        lastAppHashes.delete(appId);
        await loadAndRegisterApps(true, true);
        sendResponse({ ok: true });
      }).catch((e) => sendResponse({ error: e.message }));
      return true;
    }

    if (msg?.type === 'airglow:toggle-app') {
      const appId = msg.appId;
      getDisabledApps().then(async (disabled) => {
        const wasDisabled = disabled.has(appId);
        if (wasDisabled) disabled.delete(appId);
        else disabled.add(appId);
        const nowDisabled = !wasDisabled;
        await chrome.storage.local.set({ '__disabled_apps': Array.from(disabled) });
        lastAppHashes.delete(appId);
        // Immediately unregister this app's scripts when transitioning to
        // disabled. Works whether or not the dev server is reachable; the
        // re-register path below would otherwise no-op when offline and the
        // already-registered scripts would survive on new page loads.
        if (nowDisabled) {
          try {
            const scripts = await chrome.userScripts.getScripts();
            const ids = scripts.filter(s => s.id.startsWith(appId + '__')).map(s => s.id);
            if (ids.length > 0) await chrome.userScripts.unregister({ ids });
          } catch (e: any) {
            logger.warn('airglow', `unregister scripts for ${appId} failed: ${e?.message ?? e}`);
          }
        }
        // force=true to bypass change detection; skipReload=true — user
        // refreshes their own tabs (side panel hints "Refresh to apply").
        await loadAndRegisterApps(true, true);
        sendResponse({ ok: true, disabled: nowDisabled });
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
      Promise.all([getDisabledApps(), chrome.storage.local.get('__logs_last_seen_ts')]).then(([disabled, lastSeenRes]) => {
        const lastSeen = (lastSeenRes['__logs_last_seen_ts'] as number | undefined) ?? 0;
        const hasError = (id: string) => {
          const ts = errorsOnTab?.get(id);
          return ts !== undefined && ts > lastSeen;
        };
        const matching: { id: string; name: string; disabled: boolean; hasError?: boolean }[] = [];
        const seen = new Set<string>();

        // If appId is specified (app-shell), return just that app
        if (appId) {
          const m = allManifests.find(m => m.id === appId);
          if (m) matching.push({ id: m.id, name: m.name, disabled: disabled.has(m.id), hasError: hasError(m.id) });
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
            matching.push({ id: m.id, name: m.name, disabled: disabled.has(m.id), hasError: hasError(m.id) });
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
                  matching.push({ id: m.id, name: m.name, disabled: disabled.has(m.id), hasError: hasError(m.id) });
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
                      matching.push({ id: m.id, name: m.name, disabled: disabled.has(m.id), hasError: hasError(m.id) });
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

    // Dashboard inventory message: returns BOTH copies of an app that exists
    // in local + cloud sources (runtime list dedupes; this list doesn't),
    // so the dashboard can render shadowed-cloud rows with a badge.
    // Falls back to in-memory runtime list if inventory storage is empty
    // (first boot, or older install pre-Batch-4).
    if (msg?.type === 'airglow:get-dashboard-manifests') {
      if (dashboardAppManifests.length > 0) {
        sendResponse({ manifests: dashboardAppManifests });
        return true;
      }
      chrome.storage.local.get(APP_INVENTORY_MANIFESTS_KEY).then((result) => {
        const cached = Array.isArray(result[APP_INVENTORY_MANIFESTS_KEY])
          ? result[APP_INVENTORY_MANIFESTS_KEY]
          : getAppManifests();
        sendResponse({ manifests: cached });
      }).catch(() => {
        sendResponse({ manifests: getAppManifests() });
      });
      return true;
    }

    if (msg?.type === 'airglow:logs:get') {
      logger.getAll().then(entries => sendResponse({ entries }));
      return true;
    }

    if (msg?.type === 'airglow:logs:clear') {
      tabErrors.clear();
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
