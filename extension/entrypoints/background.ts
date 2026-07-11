import { logger } from '../lib/logger';
const log = (msg: string) => logger.info('airglow', msg);
import { handleAirglowMessage, openAppInDashboard, setAppManifests, getAppManifests, setOnAppLog } from '../lib/airglow-message-handler';
import { APP_MANIFESTS_KEY, loadAppManifests, registerAllUserscripts, runStartupScripts, type AppManifest, type SourcedManifest } from '../lib/app-loader';
import { buildSdkCode } from '../lib/airglow-sdk';
import { runtimeConfig } from '../lib/runtime-config';
import { trackDashboardOpened, trackSidepanelOpened, trackLoggedIn, trackHostInstalled, trackAgentMessageSent, trackAgentResponseReceived, trackSidepanelError, trackIdentified, trackInstalled, trackUiPageOpened, trackUserscriptInjected, type DashboardPage } from '../lib/analytics';
import * as posthog from '../lib/posthog';
import { USER_EMAIL_KEY, ensureIdentity, normalizeUserEmail } from '../lib/airglow-identity';
import { AUTH_SESSION_KEY, ensureSession, getStoredSession, signInWithGoogle } from '../lib/airglow-auth';
import { CLOUD_API_URL_OVERRIDE_KEY, getCloudApiOverride, getCloudApiUrl } from '../lib/cloud-api';
import { ANNOUNCEMENTS_CACHE_KEY, ANNOUNCEMENTS_DISMISSED_KEY, INSTALLED_AT_KEY, pickAnnouncement } from '../lib/announcements';
import { EXT_UPDATE_KEY, checkForExtUpdate } from '../lib/ext-update';

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
  // Daemon offline is intentionally excluded — it's not user-actionable from
  // the badge and the dashboard surfaces it instead.
  const DEV_SERVER_ONLINE_KEY = '__dev_server_online';
  let userScriptsAllowed = true;

  function refreshActionBadge() {
    if (userScriptsAllowed) {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: 'Airglow' });
      return;
    }
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    try { chrome.action.setBadgeTextColor?.({ color: '#ffffff' }); } catch {}
    chrome.action.setTitle({ title: 'Airglow — user scripts disabled' });
  }

  async function setDevServerOnline(online: boolean) {
    await chrome.storage.local.set({ [DEV_SERVER_ONLINE_KEY]: online });
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
  // `__airglow_skip_dev_seed` opts a profile out of that — used by
  // `pnpm chrome --ask-email` to test the email-onboarding flow.
  let lastTrackedUserEmail: string | null = null;

  function trackStoredUserEmail(emailValue: unknown) {
    const email = normalizeUserEmail(emailValue);
    if (!email) return;
    if (email === lastTrackedUserEmail) return;
    lastTrackedUserEmail = email;
    trackIdentified(email).catch((e) => {
      if (lastTrackedUserEmail === email) lastTrackedUserEmail = null;
      logger.warn('airglow', `trackIdentified failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  chrome.storage.local.onChanged.addListener((changes) => {
    if (USER_EMAIL_KEY in changes) {
      trackStoredUserEmail(changes[USER_EMAIL_KEY].newValue);
    }
  });

  (async () => {
    // Resolve user_id + auto-fill email from chrome.identity.getProfileUserInfo
    // before the email-tracking branch reads storage. ensureIdentity may write
    // USER_EMAIL_KEY, which fires the onChanged listener above.
    //
    // If an email is available, send $identify *and await it* before releasing
    // the posthog.capture gate — so the first event the user sees in PostHog
    // already has `email` set on the person (otherwise events.list renders the
    // raw distinct_id and never backfills). try/finally guarantees the gate
    // releases even on crash; the capture-side timeout is a pure safety net.
    try {
      // Silent sign-in first: refreshes/establishes the server-issued session
      // without UI when Google has already been granted, and mirrors the
      // verified userId into the legacy identity keys ensureIdentity reads.
      const session = await ensureSession().catch(() => null);
      const identity = await ensureIdentity();
      log(`identity resolved: user_id=${identity.userId}${identity.email ? ` email=${identity.email}` : ''}`);
      if (identity.email) {
        await posthog.identify().catch((e) =>
          logger.warn('airglow', `boot $identify failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      // Count this signed-in user once (deduped on userId). Not awaited: the
      // capture blocks on the identify gate, which only releases in `finally`
      // below — awaiting here would stall on its own timeout.
      if (session?.userId) {
        trackLoggedIn(session.userId).catch((e) =>
          logger.warn('airglow', `trackLoggedIn (boot) failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    } catch (e) {
      logger.error('airglow', `identity IIFE threw: ${e instanceof Error ? e.message : String(e)}`, e instanceof Error ? e.stack : undefined);
    } finally {
      posthog.markIdentifyComplete();
    }

    const result = await chrome.storage.local.get([USER_EMAIL_KEY, AUTH_SESSION_KEY, '__airglow_skip_dev_seed']);
    let stored = normalizeUserEmail(result[USER_EMAIL_KEY]);
    const skipDevSeed = result['__airglow_skip_dev_seed'] === true;
    if (!skipDevSeed && runtimeConfig.devUserEmail && runtimeConfig.devUserId) {
      const dev = normalizeUserEmail(runtimeConfig.devUserEmail);
      const patch: Record<string, unknown> = {};
      if (!stored && dev) {
        patch[USER_EMAIL_KEY] = dev;
        stored = dev;
      }
      // Auto-seed a signed-in session so dev skips the Google gate. The token is
      // intentionally empty: buildIdentityHeaders only sends `Authorization`
      // when the token is truthy, so the gateway falls back to the (also
      // dev-seeded) legacy `x-airglow-user-id` identity instead of hard-401ing
      // on a bearer it can't verify. `--ask-email` (sets __airglow_skip_dev_seed)
      // opts out to test the real onboarding gate.
      if (!result[AUTH_SESSION_KEY]) {
        patch[AUTH_SESSION_KEY] = {
          token: '',
          userId: runtimeConfig.devUserId,
          email: dev,
          expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
        patch['__airglow_user_id'] = runtimeConfig.devUserId;
      }
      if (Object.keys(patch).length) {
        await chrome.storage.local.set(patch);
        log(`dev auto-seeded signed-in session: ${dev}`);
      }
    }
    trackStoredUserEmail(stored);
  })();

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

    const { reachable, localReachable, usedCachedLocalManifests, manifests: allManifests } = await loadAppManifests();

    await setDevServerOnline(localReachable);

    // Nothing from any source — clear in-memory + early-exit. The handler's
    // own hydrate-from-storage fallback handles the SW-restart race.
    if (!reachable) {
      lastAppHashes.clear();
      dashboardAppManifests = [];
      setAppManifests([]);
      return;
    }

    // Cached replay (daemon briefly offline): keep userscripts working across
    // SW restarts. Skip housekeeping — no fresh signal to act on.
    if (usedCachedLocalManifests && allManifests.length > 0) {
      dashboardAppManifests = allManifests;
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
    dashboardAppManifests = allManifests;
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

  // ───── Native messaging bridge to the Airglow host ─────
  // The connector half of the host binary. It finds-or-spawns the daemon and
  // reports its origin in the `ready` handshake; we store that as the local
  // app source. Browser-bridge commands (tabs/eval/html/...) arrive over the
  // same port.
  const NM_HOST = 'com.airglow.host';
  const spiedTabs = new Set<number>();
  let nmPort: chrome.runtime.Port | null = null;
  // Track connection state across reconnect attempts so we log transitions only,
  // not every retry (which floods logs every 3s when the host isn't installed).
  let nmWasConnected = false;
  // Mirror connection state to storage so the dashboard can show onboarding
  // when the host isn't installed (parallel to __dev_server_online).
  const NATIVE_HOST_CONNECTED_KEY = '__native_host_connected';
  // Where the daemon serves local apps; written from the connector handshake,
  // read by the app loader as the local source origin.
  const DAEMON_ORIGIN_KEY = '__daemon_origin';
  // Daemon version from the `ready` handshake — attached to sidepanel-error reports.
  let daemonVersion: string | null = null;
  // The last `error` agent-event message, held so the matching `turn_done`
  // (which carries the HTTP status) can report the full surfaced error together.
  let pendingAgentError: { message: string; code?: string } | null = null;

  function setNativeHostConnected(connected: boolean) {
    chrome.storage.local.set({ [NATIVE_HOST_CONNECTED_KEY]: connected });
    // First successful connection on this profile = the host got installed.
    // trackHostInstalled dedups via storage, so reconnects don't re-fire.
    if (connected) {
      trackHostInstalled().catch((e) =>
        logger.warn('airglow', `trackHostInstalled failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
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

  function sendIdentityToHost() {
    Promise.all([ensureIdentity(), getStoredSession(), getCloudApiOverride()])
      .then(([{ userId, email }, session, gatewayUrl]) => {
        sendToHost({
          type: 'identity',
          userId: session?.userId ?? userId,
          email: session?.email ?? email,
          gatewayUrl,
          authToken: session?.token ?? null,
          // So the daemon can name the dashboard's chrome-extension:// URL to the
          // agent (dev vs Web Store builds have different ids).
          extensionId: chrome.runtime.id,
        });
      })
      .catch((e) => logger.warn('airglow', `identity send failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Re-send identity when the cloud-API override or the auth session changes,
  // so the daemon applies them without a reconnect.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (CLOUD_API_URL_OVERRIDE_KEY in changes || AUTH_SESSION_KEY in changes) && nmWasConnected) {
      sendIdentityToHost();
    }
    // Sign-in just landed (interactive in the banner/dashboard, or a silent
    // refresh that switched accounts). trackLoggedIn dedups on userId, so a
    // same-account refresh is a no-op.
    if (area === 'local' && AUTH_SESSION_KEY in changes) {
      const next = changes[AUTH_SESSION_KEY].newValue as { userId?: unknown } | undefined;
      const uid = typeof next?.userId === 'string' ? next.userId : '';
      if (uid) {
        trackLoggedIn(uid).catch((e) =>
          logger.warn('airglow', `trackLoggedIn failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    }
  });

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
    } else if (msg.type === 'ready') {
      log(`daemon ready at ${msg.daemonOrigin} (v${msg.daemonVersion ?? '?'})`);
      if (typeof msg.daemonVersion === 'string') daemonVersion = msg.daemonVersion;
      if (typeof msg.daemonOrigin === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(msg.daemonOrigin)) {
        chrome.storage.local.get(DAEMON_ORIGIN_KEY).then(async (r) => {
          if (r[DAEMON_ORIGIN_KEY] !== msg.daemonOrigin) {
            await chrome.storage.local.set({ [DAEMON_ORIGIN_KEY]: msg.daemonOrigin });
            // Origin changed (first connect or daemon moved ports) — re-resolve
            // apps against the new local source right away.
            loadAndRegisterApps(true).catch((e) => logger.error('airglow', `app reload after daemon handshake failed: ${e}`));
          }
        });
      }
      // Identify this browser to the daemon so agent sessions carry the
      // user's identity (gateway auth/billing) and the gateway URL override.
      sendIdentityToHost();
    } else if (msg.type === 'agent:auth_refresh') {
      // The daemon's gateway call hit AUTH_SESSION_INVALID (token expired,
      // secret rotated, or the dev switched gateway between prod and local).
      // Silently re-mint against the current backend — no UI while Google is
      // still signed in. signInWithGoogle persists the new session, which fires
      // the storage listener → sendIdentityToHost, so the daemon picks up the
      // fresh token and retries the turn. If silent sign-in is unavailable
      // (signed out of Google), the daemon times out and surfaces the error.
      void (async () => {
        try {
          await signInWithGoogle({ interactive: false });
          log('silent auth refresh succeeded (gateway token re-minted)');
        } catch (e) {
          // No silent Google session to re-mint from. The stored token is
          // known-bad (the gateway just rejected it), so drop it: the daemon's
          // wait ends immediately (token → null) and the sidepanel's
          // SignInOverlay appears, turning a dead error into a one-click
          // re-sign-in.
          logger.info('airglow', `silent auth refresh unavailable, clearing stale session: ${e instanceof Error ? e.message : String(e)}`);
          await chrome.storage.local.remove(AUTH_SESSION_KEY);
        }
      })();
    } else if (typeof msg.type === 'string' && msg.type.startsWith('agent:')) {
      // Agent chat traffic from the daemon → connected chat clients.
      // A turn_done marks a completed response; its stopReason tells us whether
      // the turn errored (see trackAgentResponseReceived). The preceding `error`
      // event carries the user-surfaced text; we hold it so turn_done (which has
      // the HTTP status) can report both together as a sidepanel_error.
      if (msg.type === 'agent:event' && msg.event?.type === 'error') {
        pendingAgentError = { message: String(msg.event.message ?? ''), code: typeof msg.event.code === 'string' ? msg.event.code : undefined };
      }
      if (msg.type === 'agent:event' && msg.event?.type === 'turn_done') {
        const ev = msg.event;
        const stopReason = String(ev.stopReason ?? 'unknown');
        trackAgentResponseReceived(
          stopReason,
          typeof ev.errorStatus === 'number' ? ev.errorStatus : undefined,
          typeof ev.errorCode === 'string' ? ev.errorCode : undefined,
        ).catch((e) =>
          logger.warn('airglow', `trackAgentResponseReceived failed: ${e instanceof Error ? e.message : String(e)}`),
        );
        if (stopReason === 'error' || stopReason === 'max_iterations') {
          trackSidepanelError({
            message: pendingAgentError?.message ?? `agent turn ${stopReason}`,
            status: typeof ev.errorStatus === 'number' ? ev.errorStatus : undefined,
            code: (typeof ev.errorCode === 'string' ? ev.errorCode : undefined) ?? pendingAgentError?.code,
            sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined,
            hostVersion: daemonVersion ?? undefined,
          }).catch((e) =>
            logger.warn('airglow', `trackSidepanelError failed: ${e instanceof Error ? e.message : String(e)}`),
          );
        }
        pendingAgentError = null;
      }
      for (const port of agentPorts) {
        try { port.postMessage(msg); } catch {}
      }
    } else if (msg.type === 'tabs') {
      // Tabs grouped by window, with explicit roles instead of raw per-window
      // `active` flags (which agents misread as "current" in multi-window
      // setups). `chatWindow: true` = the window whose sidepanel chat drives
      // this session (sidepanelWindowId, resolved by the daemon; falls back to
      // the last-focused window), and its active tab is `current` — the page
      // the user is looking at. role "agent" = THIS session's own window (open
      // and test here); "agent-other" = another agent session's window, or the
      // shared anonymous window (read-only — not yours); "user" = the user's.
      const reqSession: string | null = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      Promise.all([
        chrome.tabs.query({}),
        typeof msg.sidepanelWindowId === 'number'
          ? Promise.resolve(msg.sidepanelWindowId)
          : chrome.windows.getLastFocused().then((w) => w?.id).catch(() => undefined),
        getDebugWindow(),
        getAgentWindows(),
      ]).then(([tabs, chatWindowId, debugWindowId, agentWins]) => {
        // Every agent-owned window in this browser: per-session windows from
        // storage + the shared anonymous window. The requesting session's own is
        // `agent`; the rest are `agent-other`. (A session with no window yet, or
        // an anonymous caller before its first open, has ownId null → nothing is
        // tagged `agent` until it opens a tab.)
        const ownId: number | null = reqSession
          ? agentWins[reqSession]?.windowId ?? null
          : (typeof debugWindowId === 'number' ? debugWindowId : null);
        const allAgentIds = Object.values(agentWins).map((v) => v.windowId);
        if (typeof debugWindowId === 'number') allAgentIds.push(debugWindowId);
        const otherIds = allAgentIds.filter((id) => id !== ownId);
        const byWindow = new Map<number, { id?: number; title?: string; url?: string; current?: boolean }[]>();
        for (const t of tabs) {
          let list = byWindow.get(t.windowId);
          if (!list) byWindow.set(t.windowId, (list = []));
          list.push({
            id: t.id,
            title: t.title,
            url: t.url,
            ...(t.active && t.windowId === chatWindowId ? { current: true } : {}),
          });
        }
        const isOwn = (id: number) => id === ownId;
        const isOtherAgent = (id: number) => !isOwn(id) && otherIds.includes(id);
        const role = (id: number) => (isOwn(id) ? 'agent' : isOtherAgent(id) ? 'agent-other' : 'user');
        const rank = (id: number) => (id === chatWindowId ? 0 : isOwn(id) ? 1 : isOtherAgent(id) ? 2 : 3);
        // No windowId in the payload: no command takes one, and opaque ids
        // only invite the model to reason about them. role + chatWindow carry
        // all the semantics.
        const windows = [...byWindow.entries()]
          .sort(([a], [b]) => rank(a) - rank(b))
          .map(([windowId, windowTabs]) => ({
            role: role(windowId),
            ...(windowId === chatWindowId ? { chatWindow: true } : {}),
            tabs: windowTabs,
          }));
        sendToHost({ type: 'reply', reqId: msg.reqId, payload: { windows } });
      });
    } else if (msg.type === 'getHtml' && typeof msg.tabId === 'number') {
      reply(msg, (async () => {
        await timedStep('activate tab for html', () => activateIfOwn(msg.tabId, typeof msg.sessionId === 'string' ? msg.sessionId : null), 3000);
        flashAgentBanner(msg.tabId);
        return timedStep('read html', () => domGetHtml(msg.tabId, msg.selector, msg.frame), 9000,
          `tab ${msg.tabId}'s page is unresponsive (likely CPU-pegged); recover with \`airglow browser close --tab ${msg.tabId}\` or \`nav\` — those run browser-side and work even when the page is wedged`);
      })(), 9800);
    } else if (msg.type === 'eval' && typeof msg.tabId === 'number') {
      reply(msg, (async () => {
        await timedStep('activate tab for eval', () => activateIfOwn(msg.tabId, typeof msg.sessionId === 'string' ? msg.sessionId : null), 3000);
        flashAgentBanner(msg.tabId);
        return timedStep('evaluate script', () => domEval(msg.tabId, msg.code, msg.frame, msg.main, msg.app), stepTimeout(msg.timeout),
          `tab ${msg.tabId}'s page is unresponsive (likely CPU-pegged); recover with \`airglow browser close --tab ${msg.tabId}\` or \`nav\` — those run browser-side and work even when the page is wedged`);
      })(), 14500);
    } else if (msg.type === 'newTab') {
      reply(msg, openAgentTab(msg.url, msg.active !== false, typeof msg.sessionId === 'string' ? msg.sessionId : null).then((r: any) => {
        if (typeof r?.id === 'number') paintBannerOnNextLoad(r.id);
        return r;
      }));
    } else if (msg.type === 'navigate' && typeof msg.tabId === 'number') {
      reply(msg, (async () => {
        await timedStep('activate tab for navigation', () => activateIfOwn(msg.tabId, typeof msg.sessionId === 'string' ? msg.sessionId : null), 3000);
        paintBannerOnNextLoad(msg.tabId);
        const t = await timedStep('navigate tab', () => chrome.tabs.update(msg.tabId, { url: msg.url }), 9000);
        return { id: t?.id, url: msg.url };
      })(), 9800);
    } else if (msg.type === 'closeTab' && typeof msg.tabId === 'number') {
      reply(msg, timedStep('close tab', () => chrome.tabs.remove(msg.tabId).then(() => ({ closed: msg.tabId })), 9000), 9500);
    } else if (msg.type === 'capture' && typeof msg.tabId === 'number') {
      reply(msg, (async () => {
        await timedStep('activate tab for screenshot', () => activateIfOwn(msg.tabId, typeof msg.sessionId === 'string' ? msg.sessionId : null), 3000);
        flashAgentBanner(msg.tabId);
        return timedStep('capture screenshot', () => captureTab(msg.tabId), stepTimeout(msg.timeout),
          `tab ${msg.tabId}'s page is unresponsive (likely CPU-pegged); recover with \`airglow browser close --tab ${msg.tabId}\` or \`nav\` — those run browser-side and work even when the page is wedged`);
      })(), 14500);
    }
  }

  // Screenshot a tab as JPEG (quality 90 — much smaller than png). We use CDP's
  // Page.captureScreenshot instead of chrome.tabs.captureVisibleTab: the latter
  // only grabs the *focused* window's active tab (and hangs otherwise), forcing us
  // to yank the agent's background window to the front on every shot. CDP captures
  // a background tab in place — no focus steal. Cost: attaching the debugger shows
  // Chrome's "Airglow started debugging this browser" infobar, but only on the
  // agent's own background debug tabs, which the user isn't looking at.
  async function captureTab(tabId: number) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.windowId == null) return { error: 'no such tab' };
    try {
      await ensureAttached(tabId);
      const { data } = await cdpSend(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 90 });
      if (!data) return { error: 'capture returned no data' };
      return { dataUrl: `data:image/jpeg;base64,${data}` };
    } catch (e: any) {
      return { error: String(e?.message || e) };
    }
  }

  // ───── Agent windows ─────
  // Tabs the agent opens go into a dedicated, unfocused window — one per agent
  // session — so concurrent agents never share a window and fight over its single
  // active-tab slot. Inside that window the tabs sit in a colored "Airglow" tab
  // group, a visible marker that those tabs are agent-controlled.
  //
  // The session→window map lives HERE (chrome.storage), not in the daemon: window
  // ids are per-browser and the daemon's memory is wiped on restart, which would
  // orphan a session's window (its next tab would fork into a new window). The
  // daemon just forwards `sessionId`; we own reuse, role-labeling, and own-tab
  // activation. chrome.storage survives daemon AND service-worker restarts; only
  // a browser restart invalidates the ids, which the validate-or-recreate handles.
  // A caller with no session (anonymous: piped/headless, no AIRGLOW_SESSION, no
  // TTY) shares one find-or-create window tracked under the legacy debug keys.
  //
  // CRITICAL: the group MUST be created with `createProperties.windowId` set to
  // the agent window. Chrome's SavedTabGroups feature otherwise consolidates a
  // group born in an unfocused window into the *active* (user's) window within
  // ~1s, yanking the agent's tabs out of their window — pinning the group's home
  // window at creation prevents that (verified).
  const DEBUG_WINDOW_KEY = '__debug_window'; // anonymous (session-less) window
  const DEBUG_GROUP_KEY = '__debug_group';
  const AGENT_WINDOWS_KEY = '__agent_windows'; // { [sessionId]: { windowId, groupId } }

  type AgentWin = { windowId: number; groupId: number };

  async function getAgentWindows(): Promise<Record<string, AgentWin>> {
    const r = await chrome.storage.local.get(AGENT_WINDOWS_KEY);
    const m = r[AGENT_WINDOWS_KEY];
    return m && typeof m === 'object' ? (m as Record<string, AgentWin>) : {};
  }

  async function setAgentWindow(sessionId: string, v: AgentWin): Promise<void> {
    const m = await getAgentWindows();
    m[sessionId] = v;
    await chrome.storage.local.set({ [AGENT_WINDOWS_KEY]: m });
  }

  async function getDebugWindow(): Promise<number | null> {
    const r = await chrome.storage.local.get(DEBUG_WINDOW_KEY);
    const id = r[DEBUG_WINDOW_KEY];
    if (typeof id !== 'number') return null;
    try { await chrome.windows.get(id); return id; }
    catch { log(`agent-window: stored window ${id} gone`); return null; }
  }

  // Put `tabId` into the agent group in `windowId`: reuse `groupId` if still
  // valid, else create a fresh group PINNED to this window (see CRITICAL above)
  // and style it. Returns the group id.
  async function ensureAgentGroup(tabId: number, windowId: number, groupId: number | null): Promise<number> {
    if (groupId != null && groupId >= 0) {
      try { await chrome.tabs.group({ groupId, tabIds: [tabId] }); return groupId; }
      catch { /* stale group (window recreated) → create a fresh one below */ }
    }
    const gid = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    // 'grey' is the nearest Chrome tab-group color to black (no black in the enum).
    try { await chrome.tabGroups.update(gid, { title: 'Airglow', color: 'grey' }); } catch {}
    return gid;
  }

  // The window id the given session (or the anonymous caller) owns, or null.
  async function ownWindowFor(sessionId: string | null): Promise<number | null> {
    if (sessionId) return (await getAgentWindows())[sessionId]?.windowId ?? null;
    return getDebugWindow();
  }

  // Open a tab in the caller's agent window. With a sessionId: reuse that
  // session's stored window/group if still alive, else create a fresh window+group
  // and persist it under the session. Anonymous (no sessionId): the single
  // find-or-create window+group under the legacy debug keys.
  async function openAgentTab(url: string, active: boolean, sessionId: string | null) {
    let windowId: number | null = null;
    let groupId: number | null = null;
    if (sessionId) {
      const cur = (await getAgentWindows())[sessionId];
      if (cur) { windowId = cur.windowId; groupId = cur.groupId; }
    } else {
      const r = await chrome.storage.local.get([DEBUG_WINDOW_KEY, DEBUG_GROUP_KEY]);
      windowId = typeof r[DEBUG_WINDOW_KEY] === 'number' ? r[DEBUG_WINDOW_KEY] : null;
      groupId = typeof r[DEBUG_GROUP_KEY] === 'number' ? r[DEBUG_GROUP_KEY] : null;
    }
    // A dead window id (browser restarted, or user closed it) → fresh window+group.
    if (windowId != null) {
      try { await chrome.windows.get(windowId); }
      catch { windowId = null; groupId = null; }
    }
    let tab: chrome.tabs.Tab | undefined;
    if (windowId != null) {
      tab = await chrome.tabs.create({ windowId, url, active });
    } else {
      const win = await chrome.windows.create({ url, focused: false });
      windowId = win?.id ?? null;
      tab = win?.tabs?.[0];
      groupId = null; // fresh window → fresh group
    }
    if (windowId == null || !tab?.id) return { error: 'failed to create agent window' };
    try {
      groupId = await ensureAgentGroup(tab.id, windowId, groupId);
    } catch (e: any) {
      log(`agent-window: grouping failed (${e?.message})`);
      groupId = -1;
    }
    if (sessionId) await setAgentWindow(sessionId, { windowId, groupId });
    else await chrome.storage.local.set({ [DEBUG_WINDOW_KEY]: windowId, [DEBUG_GROUP_KEY]: groupId });
    log(`agent-window: tab ${tab.id} in window ${windowId} group ${groupId} (session ${sessionId ?? 'anon'})`);
    return { id: tab.id, url: tab.url, windowId, groupId };
  }

  // Make the agent's OWN tab the active one in its window before acting on it: a
  // non-active tab is timer-throttled and may be discarded (unloaded), so
  // eval/html/shot would hit a dead page. Only the session's own window is
  // touched — reads on a user/other-agent tab never steal their active tab. We
  // set `active`, never `focused`, so the window is not brought to the front.
  async function activateIfOwn(tabId: number, sessionId: string | null): Promise<void> {
    const ownWin = await ownWindowFor(sessionId);
    if (ownWin == null) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId === ownWin && !tab.active) {
        await chrome.tabs.update(tabId, { active: true });
      }
    } catch {}
  }

  function withTimeout<T>(label: string, p: Promise<T>, timeoutMs: number, hint?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms${hint ? ` — ${hint}` : ''}`)),
        timeoutMs,
      );
      p.then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function timedStep<T>(label: string, fn: () => Promise<T>, timeoutMs: number, hint?: string): Promise<T> {
    return withTimeout(label, Promise.resolve().then(fn), timeoutMs, hint);
  }

  // Inner timeout for renderer-bound ops (eval / screenshot). Defaults to 8s —
  // long enough for a healthy page, short enough that a wedged tab surfaces
  // fast — and an agent may raise it up to the 14s hard ceiling via --timeout.
  // The 14.5s outer reply + 15s daemon backstops already cover that ceiling.
  function stepTimeout(v: unknown): number {
    return Math.min(14000, Math.max(1000, Number(v) || 8000));
  }

  function flashAgentBanner(tabId: number) {
    void withTimeout('agent banner injection', ensureAgentBanner(tabId), 1500).catch((e) => {
      logger.warn('airglow', `agent banner skipped: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  // Resolve a tab-control promise into a native-host reply, normalizing errors.
  function reply(msg: any, p: Promise<any>, timeoutMs = 14500) {
    withTimeout(`browser ${msg?.type ?? 'command'}`, p, timeoutMs)
      .then((payload) => sendToHost({ type: 'reply', reqId: msg.reqId, payload }))
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
    // ── Activity glow ──
    // A pulsing clay border framing the viewport, shown while the agent is
    // acting on this tab. Runs on EVERY action (before the banner's early
    // returns) and resets a 5s timer, so it lingers through a burst of actions
    // and fades 5s after the last one. Independent of the banner's dismiss.
    (function refreshGlow() {
      const GLOW_ID = '__airglow_glow';
      const w = window as any;
      if (!document.getElementById('__airglow_glow_style')) {
        const s = document.createElement('style');
        s.id = '__airglow_glow_style';
        s.textContent =
          '@keyframes __airglow_glow_pulse {' +
          ' 0%,100% { box-shadow: inset 0 0 0 2px rgba(251,134,74,0.80), inset 0 0 16px 1px rgba(251,134,74,0.32); }' +
          ' 50% { box-shadow: inset 0 0 0 2px rgba(251,134,74,1), inset 0 0 30px 5px rgba(251,134,74,0.60); } }';
        (document.head || document.documentElement).appendChild(s);
      }
      let glow = document.getElementById(GLOW_ID);
      if (!glow) {
        glow = document.createElement('div');
        glow.id = GLOW_ID;
        glow.style.cssText = [
          'all: initial', 'position: fixed', 'inset: 0', 'pointer-events: none',
          'z-index: 2147483646', 'border-radius: 7px',
          'animation: __airglow_glow_pulse 2.4s ease-in-out infinite',
          'opacity: 1', 'transition: opacity 0.6s ease',
        ].join(';');
        (document.body || document.documentElement).appendChild(glow);
      }
      glow.style.opacity = '1';
      clearTimeout(w.__airglowGlowTimer);
      w.__airglowGlowTimer = setTimeout(() => {
        const g = document.getElementById(GLOW_ID);
        if (!g) return;
        g.style.opacity = '0';
        setTimeout(() => g.remove(), 650);
      }, 5000);
    })();

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
  // substring) to target a child frame instead of the top document — e.g. an
  // app's UI iframe embedded in the dashboard.
  async function resolveFrameId(tabId: number, frameMatch?: string | null): Promise<number> {
    if (!frameMatch) return 0; // top frame
    const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    const m = frames.find((f) => (f.url || '').includes(frameMatch));
    if (!m) throw new Error(`no frame matches "${frameMatch}" (frames: ${frames.map((f) => f.url).join(' | ')})`);
    return m.frameId;
  }

  async function domGetHtml(tabId: number, selector?: string | null, frame?: string | null) {
    if (await isExtensionTab(tabId)) return cdpGetHtml(tabId, selector, frame);
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

  // eval first runs in a dedicated USER_SCRIPT world. Most pages allow that
  // wrapper, but some strict-CSP pages still block the Function constructor used
  // to turn a CLI string into executable code. For normal eval we fall back to
  // CDP Runtime.evaluate, which evaluates the expression directly and is not
  // subject to the page's script-src unsafe-eval rule.
  const EVAL_WORLD_ID = 'airglow-eval';
  let evalWorldReady = false;
  async function ensureEvalWorld() {
    if (evalWorldReady) return;
    await chrome.userScripts.configureWorld({ worldId: EVAL_WORLD_ID, csp: "script-src 'self' 'unsafe-eval'", messaging: false });
    evalWorldReady = true;
  }

  // Wrap user code so `await` works and a bare expression yields its value.
  // The code runs as an async function body (needs 'unsafe-eval' in the world —
  // both the eval world and --app's world set it). `return (code)` is tried
  // first so an expression returns its value; on a syntax error (statements) it
  // falls back to running them as-is (value undefined). Most of the SDK is async
  // (storage/rpc/llm return promises), so without this `eval` would hand back a
  // stringified Promise instead of the resolved value.
  function evalBody(code: string): string {
    return `(async () => {
      const __AF = Object.getPrototypeOf(async function(){}).constructor;
      const __mk = (src) => { try { return new __AF('return (' + src + '\\n);'); } catch (e) { return new __AF(src); } };
      try {
        const __v = await __mk(${JSON.stringify(code)})();
        try { return { value: JSON.parse(JSON.stringify(__v ?? null)) }; } catch { return { value: String(__v) }; }
      } catch (e) { return { error: String((e && e.message) || e) }; }
    })()`;
  }

  function isCspEvalBlocked(payload: unknown): boolean {
    const error = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error ?? '')
      : '';
    return /Content Security Policy|unsafe-eval|violates.*script-src/i.test(error);
  }

  // `eval --app ID`: run `code` in app ID's own userscript world (worldId
  // `airglow:ID`), so the SDK's chrome.runtime.sendMessage passes the
  // background's worldId == `airglow:ID` check and storage/rpc/llm scope to that
  // app. The app's world is normally CSP `script-src 'self'` (no eval); widen it
  // to permit the wrapper. The SDK is (re)injected only when absent, so a live
  // app instance on the tab is left intact. The widening resets the next time
  // apps are registered.
  async function evalInAppWorld(tabId: number, frameId: number, appId: string, code: string) {
    await chrome.userScripts.configureWorld({ worldId: `airglow:${appId}`, csp: "script-src 'self' 'unsafe-eval'", messaging: true });
    const sdk = buildSdkCode(appId, 'userscript');
    const js = `if (typeof globalThis.airglow === 'undefined') {\n${sdk}\n}\n${evalBody(code)}`;
    const results = await chrome.userScripts.execute({
      target: { tabId, frameIds: [frameId] },
      worldId: `airglow:${appId}`,
      injectImmediately: true,
      js: [{ code: js }],
    } as any);
    const r = (results as any)?.[0];
    if (r?.error) return { error: String(r.error?.message || r.error) };
    return r?.result ?? { error: 'no result' };
  }

  async function domEval(tabId: number, code: string, frame?: string | null, main?: boolean, app?: string | null) {
    // Our own chrome-extension:// pages (the dashboard, side panel) can't be reached
    // by chrome.scripting/userScripts — host_permissions don't match that scheme.
    // chrome.debugger is the only bypass; it also ignores page CSP, so the top
    // frame runs in the page's real context (page globals like window.__test are
    // visible — `main` is effectively always on for extension pages).
    if (await isExtensionTab(tabId)) return cdpEval(tabId, code, frame);
    // Default: run in a USER_SCRIPT world — CSP-exempt, DOM-complete, but its own
    // `window` (page/app globals like window.__test are NOT visible). Pass main=true
    // to run in the page's MAIN world instead: sees page globals, but the page's CSP
    // applies to eval (so it can be blocked on strict-CSP sites).
    //
    // The body is an async IIFE; userScripts.execute / scripting.executeScript
    // await the returned promise and hand back its resolved value.
    const body = evalBody(code);
    try {
      const frameId = await resolveFrameId(tabId, frame);
      if (!main && chrome.userScripts?.execute) {
        // --app: run in app `app`'s userscript world with its `airglow` SDK in
        // scope, so storage/rpc/llm calls route with that app's identity.
        if (app) return evalInAppWorld(tabId, frameId, app, code);
        await ensureEvalWorld();
        const results = await chrome.userScripts.execute({
          target: { tabId, frameIds: [frameId] },
          worldId: EVAL_WORLD_ID,
          injectImmediately: true,
          js: [{ code: body }],
        } as any);
        const r = (results as any)?.[0];
        const payload = r?.error ? { error: String(r.error?.message || r.error) } : r?.result ?? { error: 'no result' };
        if (isCspEvalBlocked(payload)) return cdpEval(tabId, code, frame);
        return payload;
      }
      // MAIN world (explicit --main, or fallback when userScripts.execute is
      // unavailable): sees page globals; the page CSP can block eval/Function.
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] }, world: 'MAIN' as any,
        func: async (src: string) => {
          try {
            const AF: any = Object.getPrototypeOf(async function(){}).constructor;
            let fn; try { fn = new AF('return (' + src + '\n);'); } catch { fn = new AF(src); }
            const v = await fn();
            try { return { value: JSON.parse(JSON.stringify(v ?? null)) }; } catch { return { value: String(v) }; }
          } catch (e: any) { return { error: String((e && e.message) || e) }; }
        },
        args: [code],
      });
      const payload = res?.result ?? { error: 'no result' };
      if (isCspEvalBlocked(payload)) return cdpEval(tabId, code, frame);
      return payload;
    } catch (e: any) {
      const payload = { error: String(e?.message || e) };
      if (!app && isCspEvalBlocked(payload)) return cdpEval(tabId, code, frame);
      return payload;
    }
  }

  // ───── Driving our own chrome-extension:// pages via chrome.debugger (CDP) ─────
  // host_permissions can't match the chrome-extension scheme, so scripting/
  // userScripts are refused on the dashboard, side panel, etc. The debugger API
  // is the supported bypass (it also ignores page CSP). Attachment is per-tab
  // and reused across commands — Chrome shows its "Airglow started debugging
  // this browser" infobar while attached, but only on these agent debug tabs.
  const cdpAttached = new Set<number>();

  async function isExtensionTab(tabId: number): Promise<boolean> {
    try {
      const t = await chrome.tabs.get(tabId);
      return !!t.url?.startsWith('chrome-extension://');
    } catch { return false; }
  }

  async function ensureAttached(tabId: number): Promise<void> {
    if (cdpAttached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, '1.3');
    cdpAttached.add(tabId);
  }

  function cdpSend(tabId: number, method: string, params?: Record<string, unknown>): Promise<any> {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  // CDP and chrome.webNavigation use different frame-id spaces, so resolve the
  // child frame through CDP's own tree (matched by URL substring, like
  // resolveFrameId) and run in an isolated world there. DOM is shared, so reads
  // and clicks work; page globals in the child frame are not visible (use the
  // top-level-tab workaround for an app iframe's MAIN world — see docs).
  function findFrameId(node: any, match: string): string | null {
    if (node?.frame?.url?.includes(match)) return node.frame.id;
    for (const child of node?.childFrames || []) {
      const found = findFrameId(child, match);
      if (found) return found;
    }
    return null;
  }

  // Evaluate `expression` (passed straight to Runtime.evaluate — never wrapped in
  // an in-page eval(), which the extension-page CSP would block) and return its
  // value by value. Statements are fine; the completion value comes back.
  async function cdpEvaluate(tabId: number, expression: string, frame?: string | null): Promise<{ value: any } | { error: string }> {
    try {
      await ensureAttached(tabId);
      let contextId: number | undefined;
      if (frame) {
        await cdpSend(tabId, 'Page.enable');
        const { frameTree } = await cdpSend(tabId, 'Page.getFrameTree');
        const frameId = findFrameId(frameTree, frame);
        if (!frameId) return { error: `no frame matches "${frame}"` };
        const r = await cdpSend(tabId, 'Page.createIsolatedWorld', { frameId, worldName: 'airglow-eval' });
        contextId = r?.executionContextId;
      }
      const res = await cdpSend(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        // Resolve a promise result (e.g. an airglow.* call) to its value.
        awaitPromise: true,
        ...(contextId ? { contextId } : {}),
      });
      if (res?.exceptionDetails) {
        const ex = res.exceptionDetails;
        return { error: String(ex.exception?.description || ex.text || 'eval error') };
      }
      return { value: res?.result?.value ?? res?.result?.description ?? null };
    } catch (e: any) { return { error: String(e?.message || e) }; }
  }

  function cdpEvalExpression(code: string): string {
    return `(async () => {
      try {
        const __v = await (${code}
);
        try { return { value: JSON.parse(JSON.stringify(__v ?? null)) }; } catch { return { value: String(__v) }; }
      } catch (e) { return { error: String((e && e.message) || e) }; }
    })()`;
  }

  function cdpEvalStatements(code: string): string {
    return `(async () => {
      try {
${code}
        return { value: null };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    })()`;
  }

  function normalizeEvalPayload(result: { value: any } | { error: string }) {
    if ('error' in result) return result;
    const value = result.value;
    if (value && typeof value === 'object' && ('value' in value || 'error' in value)) return value;
    return { value: value ?? null };
  }

  async function cdpEval(tabId: number, code: string, frame?: string | null) {
    const expressionResult = await cdpEvaluate(tabId, cdpEvalExpression(code), frame);
    if ('error' in expressionResult && /SyntaxError|Unexpected token|Unexpected identifier/i.test(expressionResult.error)) {
      return normalizeEvalPayload(await cdpEvaluate(tabId, cdpEvalStatements(code), frame));
    }
    return normalizeEvalPayload(expressionResult);
  }

  async function cdpGetHtml(tabId: number, selector?: string | null, frame?: string | null) {
    const expr = selector
      ? `(()=>{const el=document.querySelector(${JSON.stringify(selector)});`
        + ` if(!el) throw new Error('no element matches selector: '+${JSON.stringify(selector)});`
        + ` return el.outerHTML;})()`
      : 'document.documentElement.outerHTML';
    const r = await cdpEvaluate(tabId, expr, frame);
    return 'error' in r ? r : { html: r.value };
  }

  // Drop attachment state when the tab closes or the debugger detaches (e.g. the
  // user clicks "Cancel" on the infobar, or DevTools takes over).
  chrome.debugger.onDetach.addListener((src) => {
    if (typeof src.tabId === 'number') cdpAttached.delete(src.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => { cdpAttached.delete(tabId); });

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

  // ───── Agent chat relay (sidepanel ⇄ daemon) ─────
  // The sidepanel connects a Port named 'airglow-agent'; its messages
  // (agent:start / agent:followup / agent:sessions) go to the daemon over
  // native messaging, and daemon agent:* messages fan out to all chat ports.
  const agentPorts = new Set<chrome.runtime.Port>();
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'airglow-agent') return;
    agentPorts.add(port);
    port.onDisconnect.addListener(() => agentPorts.delete(port));
    port.onMessage.addListener((msg: any) => {
      if (typeof msg?.type === 'string' && msg.type.startsWith('agent:')) {
        // agent:start / agent:followup are user-initiated turns → count as a
        // sent message.
        if (msg.type === 'agent:start' || msg.type === 'agent:followup') {
          trackAgentMessageSent().catch((e) =>
            logger.warn('airglow', `trackAgentMessageSent failed: ${e instanceof Error ? e.message : String(e)}`),
          );
        }
        sendToHost(msg);
      }
    });
  });

  setNativeHostConnected(false); // seed: dashboard shows "Disconnected" until the host replies
  connectNativeHost();



  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return; // main frame only
    try {
      trackUserscriptInjectedForUrl(details.url).catch((e) =>
        logger.warn('airglow', `track userscript injection failed: ${e instanceof Error ? e.message : String(e)}`)
      );
      // Trace injection: only for tabs Claude has attached via native host.
      if (spiedTabs.has(details.tabId)) {
        injectTrace(details.tabId).catch((e) => logger.error('airglow', `trace inject failed: ${e}`));
      }
    } catch {}
  });



  // Open dashboard on first install
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      // Anchor announcement visibility: this fresh install only sees
      // announcements published after now (unless audience:'all').
      chrome.storage.local.set({ [INSTALLED_AT_KEY]: Date.now() });
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      trackInstalled().catch((e) =>
        logger.warn('airglow', `trackInstalled failed: ${e instanceof Error ? e.message : String(e)}`)
      );
    }
  });

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

  // Extension icon click → dashboard by default; the agent sidepanel instead
  // when the user enables it in Settings ("Enable sidepanel").
  const SIDEPANEL_ENABLED_KEY = '__sidepanel_enabled';
  const applyActionClickBehavior = (sidepanel: boolean) => {
    chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: sidepanel })
      .catch((e: any) => logger.warn('airglow', `sidePanel behavior failed: ${e?.message ?? e}`));
  };
  chrome.storage.local.get(SIDEPANEL_ENABLED_KEY, (r) => applyActionClickBehavior(!!r[SIDEPANEL_ENABLED_KEY]));
  chrome.storage.local.onChanged.addListener((changes) => {
    if (SIDEPANEL_ENABLED_KEY in changes) applyActionClickBehavior(!!changes[SIDEPANEL_ENABLED_KEY].newValue);
  });
  chrome.action.onClicked.addListener(() => {
    chrome.storage.local.get(SIDEPANEL_ENABLED_KEY, (r) => {
      if (r[SIDEPANEL_ENABLED_KEY]) return; // panel behavior handles the click
      const dashboardUrl = chrome.runtime.getURL('dashboard.html');
      chrome.tabs.query({ url: dashboardUrl + '*' }, (tabs) => {
        const existing = tabs[0];
        if (existing?.id !== undefined) {
          chrome.tabs.update(existing.id, { active: true });
          if (existing.windowId !== undefined) chrome.windows.update(existing.windowId, { focused: true });
        } else {
          chrome.tabs.create({ url: dashboardUrl });
        }
      });
    });
  });

  // Alt+G → reload the extension from disk (dev: pick up a fresh export).
  chrome.commands?.onCommand.addListener((command) => {
    if (command === 'reload-extension') chrome.runtime.reload();
  });

  // ── Server-driven announcements ──
  // Poll the cloud for the current announcement set (DATA only — the bundle
  // renders it) and cache the array; the dashboard banner reads the cache.
  async function pollAnnouncements(): Promise<void> {
    try {
      const cloud = await getCloudApiUrl();
      const res = await fetch(`${cloud}/api/announcement`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json().catch(() => null);
      const list = Array.isArray(body?.announcements) ? body.announcements : [];
      await chrome.storage.local.set({ [ANNOUNCEMENTS_CACHE_KEY]: list });
    } catch (e) {
      logger.warn('airglow', `announcement poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Backfill install time for upgrades/unknown installs → 0 = "existing user",
  // eligible for current announcements (don't stamp `now`, that would suppress
  // the first one we want them to see). Fresh installs set `now` in onInstalled.
  chrome.storage.local.get(INSTALLED_AT_KEY, (r) => {
    if (r[INSTALLED_AT_KEY] === undefined) chrome.storage.local.set({ [INSTALLED_AT_KEY]: 0 });
  });
  // chrome.alarms survives service-worker suspension; poll on a slow cadence
  // (requestUpdateCheck-style throttling doesn't apply — this is a plain fetch).
  chrome.alarms.create('airglow:announcements', { periodInMinutes: 30 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'airglow:announcements') void pollAnnouncements();
  });
  void pollAnnouncements();

  // Extension self-update: force a Web Store check every 20 min, and persist a
  // staged newer version (Chrome fires onUpdateAvailable once it's downloaded)
  // so the dashboard + sidepanel can offer an "Update" button. No-op in dev.
  chrome.alarms.create('airglow:ext-update', { periodInMinutes: 20 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'airglow:ext-update') void checkForExtUpdate();
  });
  chrome.runtime.onUpdateAvailable.addListener((details) => {
    if (details?.version) void chrome.storage.local.set({ [EXT_UPDATE_KEY]: details.version });
  });
  void checkForExtUpdate();

  // Toolbar badge: a red "!" on the extension icon whenever an undismissed
  // announcement is active (same pick rule as the banner) — so a pinned user
  // sees there's an announcement without opening the panel. It stays until the
  // user dismisses it (dismissal writes the id, which removes it from the active
  // pick) and is cleared when none are active. The `alarms` poll keeps it
  // current while the panel is closed and the SW is otherwise idle.
  async function updateAnnouncementBadge(): Promise<void> {
    try {
      const r = await chrome.storage.local.get([ANNOUNCEMENTS_CACHE_KEY, ANNOUNCEMENTS_DISMISSED_KEY, INSTALLED_AT_KEY]);
      const list = Array.isArray(r[ANNOUNCEMENTS_CACHE_KEY]) ? r[ANNOUNCEMENTS_CACHE_KEY] : [];
      const dismissed = Array.isArray(r[ANNOUNCEMENTS_DISMISSED_KEY]) ? r[ANNOUNCEMENTS_DISMISSED_KEY] : [];
      const installedAt = typeof r[INSTALLED_AT_KEY] === 'number' ? r[INSTALLED_AT_KEY] : 0;
      const active = pickAnnouncement(list, { installedAt, dismissed, version: chrome.runtime.getManifest().version, now: Date.now() });
      if (active) {
        await chrome.action.setBadgeText({ text: '!' });
        await chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
        chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
        await chrome.action.setTitle({ title: `Airglow — ${active.title}` });
      } else {
        await chrome.action.setBadgeText({ text: '' });
        await chrome.action.setTitle({ title: 'Airglow' });
      }
    } catch (e) {
      logger.warn('airglow', `announcement badge update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Recompute on every poll (cache write), dismissal, or install-time change.
  chrome.storage.local.onChanged.addListener((changes) => {
    if (ANNOUNCEMENTS_CACHE_KEY in changes || ANNOUNCEMENTS_DISMISSED_KEY in changes || INSTALLED_AT_KEY in changes) {
      void updateAnnouncementBadge();
    }
  });
  void updateAnnouncementBadge();

  // ── Per-tab error tracking (in-memory, for edge button indicators) ──
  // tabId → appId → latest error/warn ts. Compared against __logs_last_seen_ts
  // so the indicator clears once the user reads the logs page.
  const tabErrors = new Map<number, Map<string, number>>();

  type PageApp = {
    id: string;
    name: string;
    disabled: boolean;
    hasError?: boolean;
    sourceType: SourcedManifest['_sourceType'];
  };

  function normalizeDashboardPage(value: unknown): DashboardPage {
    return value === 'logs' ? 'logs' : 'apps';
  }

  function urlMatchesPattern(pattern: string, rawUrl: string): boolean {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(rawUrl);
  }

  async function trackUserscriptInjectedForUrl(rawUrl: string) {
    if (!userScriptsAllowed || !/^https?:\/\//.test(rawUrl)) return;
    const disabled = await getDisabledApps();
    for (const manifest of getAppManifests()) {
      if (disabled.has(manifest.id)) continue;
      const matches = manifest.userscripts?.some((userscript) =>
        userscript.matches.some((pattern) => urlMatchesPattern(pattern, rawUrl))
      );
      if (matches) await trackUserscriptInjected(manifest.id);
    }
  }

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

    if (msg?.type === 'airglow:track-ui-page-opened') {
      const appId = typeof msg.appId === 'string' ? msg.appId : '';
      (async () => {
        if (!appId) {
          sendResponse({ ok: false, error: 'missing appId' });
          return;
        }
        await trackUiPageOpened(appId);
        sendResponse({ ok: true });
      })().catch((e) => {
        logger.warn('airglow', `track UI page opened failed: ${e instanceof Error ? e.message : String(e)}`);
        sendResponse({ ok: false, error: 'track UI page opened failed' });
      });
      return true;
    }

    if (msg?.type === 'airglow:track-dashboard-opened') {
      (async () => {
        await trackDashboardOpened(normalizeDashboardPage(msg.page));
        sendResponse({ ok: true });
      })().catch((e) => {
        logger.warn('airglow', `trackDashboardOpened failed: ${e instanceof Error ? e.message : String(e)}`);
        sendResponse({ ok: false, error: 'track dashboard opened failed' });
      });
      return true;
    }

    if (msg?.type === 'airglow:track-sidepanel-opened') {
      (async () => {
        await trackSidepanelOpened();
        sendResponse({ ok: true });
      })().catch((e) => {
        logger.warn('airglow', `trackSidepanelOpened failed: ${e instanceof Error ? e.message : String(e)}`);
        sendResponse({ ok: false, error: 'track sidepanel opened failed' });
      });
      return true;
    }

    // SDK-bridge `airglow:open-app` (userscript/app_ui paths, `_airglow`-flagged)
    // is served by handleAirglowMessage above. The edge-button popup sends a
    // plain `airglow:open-app` (no `_airglow` flag), so it falls through to here.
    if (msg?.type === 'airglow:open-app') {
      return openAppInDashboard(msg, sendResponse);
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
      // Return apps matching a given URL (or a specific appId for an embedded app view), with disabled status
      const url = msg.url as string;
      const appId = msg.appId as string | undefined;
      const senderTabId = _sender?.tab?.id;
      const errorsOnTab = senderTabId ? tabErrors.get(senderTabId) : undefined;
      const allManifests = getAppManifests();
      Promise.all([getDisabledApps(), chrome.storage.local.get('__logs_last_seen_ts')]).then(async ([disabled, lastSeenRes]) => {
        const lastSeen = (lastSeenRes['__logs_last_seen_ts'] as number | undefined) ?? 0;
        const hasError = (id: string) => {
          const ts = errorsOnTab?.get(id);
          return ts !== undefined && ts > lastSeen;
        };
        const matching: PageApp[] = [];
        const seen = new Set<string>();
        const addMatchingApp = (m: SourcedManifest) => {
          const isDisabled = disabled.has(m.id);
          matching.push({
            id: m.id,
            name: m.name,
            disabled: isDisabled,
            hasError: hasError(m.id),
            sourceType: m._sourceType,
          });
        };

        // If appId is specified (embedded app view), return just that app
        if (appId) {
          const m = allManifests.find(m => m.id === appId);
          if (m) addMatchingApp(m);
          sendResponse({ apps: matching });
          return;
        }

        // Check userscript matches
        for (const m of allManifests) {
          if (m.userscripts?.some(us =>
            us.matches.some(p => urlMatchesPattern(p, url))
          )) {
            seen.add(m.id);
            addMatchingApp(m);
          }
        }

        sendResponse({ apps: matching });
      }).catch((e) => {
        logger.warn('airglow', `get page apps failed: ${e instanceof Error ? e.message : String(e)}`);
        sendResponse({ error: 'get page apps failed' });
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

    if (msg?.type === 'airglow:get-manifests') {
      sendResponse({ manifests: getAppManifests() });
      return true;
    }

    // Dashboard manifest list. Falls back to the cached storage snapshot when
    // the in-memory list is empty (SW restart before the first load finishes).
    if (msg?.type === 'airglow:get-dashboard-manifests') {
      if (dashboardAppManifests.length > 0) {
        sendResponse({ manifests: dashboardAppManifests });
        return true;
      }
      chrome.storage.local.get(APP_MANIFESTS_KEY).then((result) => {
        const cached = Array.isArray(result[APP_MANIFESTS_KEY])
          ? result[APP_MANIFESTS_KEY]
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
