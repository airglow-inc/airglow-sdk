/**
 * App loader — loads manifests from the local daemon and the cloud catalog
 * tier, merges them (daemon wins per appId), and registers userscripts.
 */

import { buildSdkCode } from './airglow-sdk';
import { getCloudApiUrl } from './cloud-api';
import { getStoredSession } from './airglow-auth';
import { logger } from './logger';
import { trackAppsRegistered } from './analytics';
import { ensureAirglowOffscreenDocument, sendRuntimeMessageWhenReady } from './offscreen-runtime';
import {
  buildSourceMap,
  resolveAppManifests,
  type AppManifest,
  type AppSource,
  type SourcedManifest,
} from './app-resolver';

export type { AppManifest, AppSource, SourcedManifest, AppVisibility } from './app-resolver';

// Where the daemon serves local apps. Written by the background from the
// connector handshake; the default matches the daemon's default port so a
// daemon started before the first handshake still resolves.
const DAEMON_ORIGIN_KEY = '__daemon_origin';
const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:3222';
const LOCAL_SOURCE_TIMEOUT_MS = 4000;
const CLOUD_SOURCE_TIMEOUT_MS = 8000;

async function getLocalSource(): Promise<AppSource> {
  const result = await chrome.storage.local.get(DAEMON_ORIGIN_KEY);
  const origin = typeof result[DAEMON_ORIGIN_KEY] === 'string' && result[DAEMON_ORIGIN_KEY]
    ? (result[DAEMON_ORIGIN_KEY] as string)
    : DEFAULT_DAEMON_ORIGIN;
  return { url: origin, type: 'local' };
}

// The cloud tier serves the user's catalog installs. Its manifest listing is
// per-account, so without a signed-in session there is no cloud source.
async function getCloudSource(): Promise<AppSource | null> {
  const session = await getStoredSession();
  if (!session?.token) return null;
  return { url: await getCloudApiUrl(), type: 'cloud' };
}

// /api/apps/manifests on the cloud asserts the same identity scheme as the
// LLM gateway; bundle fetches are public and need no headers.
async function cloudIdentityHeaders(): Promise<Record<string, string> | undefined> {
  const session = await getStoredSession();
  if (!session?.token) return undefined;
  const headers: Record<string, string> = {
    'X-Airglow-App-Id': 'airglow-extension',
    Authorization: `Bearer ${session.token}`,
  };
  if (session.userId) headers['X-Airglow-User-Id'] = session.userId;
  if (session.email) headers['X-Airglow-User-Email'] = session.email;
  return headers;
}

const APP_SOURCES_KEY = '__app_sources';
export const APP_MANIFESTS_KEY = '__app_manifests';
// Dev toggle (Settings → Disable daemon): simulate "no host installed" — the
// local source is skipped entirely (no live fetch, no cached fallback) so only
// cloud catalog apps load and the daemonless UX can be exercised.
export const DAEMON_DISABLED_KEY = '__daemon_disabled';
// Per-app userscript source cache. Keyed by appId; hash-gated so we only
// re-fetch when the manifest's _hash actually changes. Lets the extension
// re-register userscripts on SW restart while the source is offline.
const APP_SOURCE_CACHE_KEY = '__app_sources_cache';
// The cached local snapshot only replays for this long after the daemon stops
// answering. Within the window brief daemon restarts (dev takeover, machine
// boot) don't flap apps; past it the host is considered off — local apps drop
// out of the merged list (cards disappear, userscripts unregister) and a
// same-id cloud app takes over. Anchored to the first failed poll, not the
// last success, so a browser started after days offline still gets the window.
const LOCAL_CACHE_GRACE_MS = 60_000;
const LOCAL_OFFLINE_SINCE_KEY = '__local_offline_since';

interface AppSourceCacheEntry {
  hash: string;
  userscripts: Record<string, string>;
}
type AppSourceCache = Record<string, AppSourceCacheEntry>;

async function readSourceCache(): Promise<AppSourceCache> {
  return new Promise((resolve) => {
    chrome.storage.local.get(APP_SOURCE_CACHE_KEY, (r) => {
      resolve((r[APP_SOURCE_CACHE_KEY] as AppSourceCache | undefined) || {});
    });
  });
}

async function writeSourceCache(cache: AppSourceCache): Promise<void> {
  await chrome.storage.local.set({ [APP_SOURCE_CACHE_KEY]: cache });
}

async function fetchAppSource(source: AppSource, url: string, headers?: Record<string, string>): Promise<Response> {
  const timeout = source.type === 'cloud' ? CLOUD_SOURCE_TIMEOUT_MS : LOCAL_SOURCE_TIMEOUT_MS;
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`app source ${source.url} unreachable: ${message}`);
  }
}

async function fetchSourceManifests(source: AppSource): Promise<AppManifest[] | null> {
  try {
    const headers = source.type === 'cloud' ? await cloudIdentityHeaders() : undefined;
    const res = await fetchAppSource(source, `${source.url}/api/apps/manifests`, headers);
    if (!res.ok) {
      logger.warn('airglow', `app source ${source.url} returned ${res.status}`);
      return null;
    }
    const manifests = await res.json();
    return Array.isArray(manifests) ? manifests : null;
  } catch (error) {
    logger.warn(
      'airglow',
      `app source ${source.url} unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function getCachedManifests(type: 'local' | 'cloud'): Promise<SourcedManifest[]> {
  const stored = await chrome.storage.local.get(APP_MANIFESTS_KEY);
  const cached = stored[APP_MANIFESTS_KEY];
  if (!Array.isArray(cached)) return [];
  return cached.filter((manifest): manifest is SourcedManifest =>
    Boolean(manifest && typeof manifest === 'object' && (manifest as SourcedManifest)._source)
    && (manifest as SourcedManifest)._sourceType === type,
  );
}

function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function setChangedStorageValues(values: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(values);
  const current = await chrome.storage.local.get(keys);
  const changed: Record<string, unknown> = {};
  for (const key of keys) {
    if (!jsonEquals(current[key], values[key])) changed[key] = values[key];
  }
  if (Object.keys(changed).length > 0) await chrome.storage.local.set(changed);
}

export interface LoadResult {
  // True if any source provided manifests (live OR fall-back-cached).
  reachable: boolean;
  localReachable: boolean;
  cloudReachable: boolean;
  // True when the daemon was unreachable and we replayed the prior snapshot.
  usedCachedLocalManifests: boolean;
  manifests: SourcedManifest[];
}

// The background polls manifests every few seconds to catch live daemon dev
// edits; per-account cloud listings only change on install/uninstall/publish,
// so reuse the last cloud response between polls. Install paths force-refresh.
const CLOUD_MANIFESTS_TTL_MS = 60_000;
// Keyed by gateway URL + user so an account or prod↔local gateway switch
// within the TTL can't serve the previous identity's app list.
let cloudManifestsCache: { at: number; key: string; manifests: AppManifest[] } | null = null;

async function fetchCloudManifests(source: AppSource, force: boolean): Promise<AppManifest[] | null> {
  const session = await getStoredSession();
  const key = `${source.url}|${session?.userId || ''}`;
  if (!force && cloudManifestsCache && cloudManifestsCache.key === key
      && Date.now() - cloudManifestsCache.at < CLOUD_MANIFESTS_TTL_MS) {
    return cloudManifestsCache.manifests;
  }
  const manifests = await fetchSourceManifests(source);
  if (manifests) cloudManifestsCache = { at: Date.now(), key, manifests };
  return manifests;
}

/**
 * Load manifests from both sources — the local daemon and the cloud catalog
 * tier — and merge them, daemon winning per appId (a local copy of an app
 * shadows the cloud-published one). Each source falls back to its cached
 * snapshot when unreachable so userscripts keep working across SW restarts —
 * the local fallback only within LOCAL_CACHE_GRACE_MS of the daemon going
 * quiet, the cloud one indefinitely (network blips shouldn't kill catalog
 * apps; a live cloud response that omits an app is what removes it).
 */
export async function loadAppManifests(opts?: { forceCloud?: boolean }): Promise<LoadResult> {
  const localSource = await getLocalSource();
  const cloudSource = await getCloudSource();
  const stored = await chrome.storage.local.get([DAEMON_DISABLED_KEY, LOCAL_OFFLINE_SINCE_KEY]);
  const daemonDisabled = Boolean(stored[DAEMON_DISABLED_KEY]);
  const offlineSince = typeof stored[LOCAL_OFFLINE_SINCE_KEY] === 'number'
    ? (stored[LOCAL_OFFLINE_SINCE_KEY] as number)
    : null;
  const [localManifests, cloudManifests] = await Promise.all([
    daemonDisabled ? Promise.resolve(null) : fetchSourceManifests(localSource),
    cloudSource ? fetchCloudManifests(cloudSource, opts?.forceCloud ?? false) : Promise.resolve(null),
  ]);

  let usedCachedLocalManifests = false;
  let localExpired = false;
  let local: SourcedManifest[];
  if (localManifests) {
    local = resolveAppManifests(localSource, localManifests);
    if (offlineSince !== null) await chrome.storage.local.remove(LOCAL_OFFLINE_SINCE_KEY);
  } else if (daemonDisabled) {
    local = [];
    if (offlineSince !== null) await chrome.storage.local.remove(LOCAL_OFFLINE_SINCE_KEY);
  } else if (offlineSince !== null && Date.now() - offlineSince > LOCAL_CACHE_GRACE_MS) {
    // Host off past the grace window: stop replaying the cached snapshot so
    // local apps disappear instead of lingering as stale cards.
    local = [];
    localExpired = true;
  } else {
    if (offlineSince === null) {
      await chrome.storage.local.set({ [LOCAL_OFFLINE_SINCE_KEY]: Date.now() });
    }
    local = resolveAppManifests(localSource, await getCachedManifests('local'));
    usedCachedLocalManifests = local.length > 0;
  }

  let usedCachedCloudManifests = false;
  let cloud: SourcedManifest[] = [];
  if (cloudSource) {
    if (cloudManifests) {
      cloud = resolveAppManifests(cloudSource, cloudManifests);
    } else {
      cloud = resolveAppManifests(cloudSource, await getCachedManifests('cloud'));
      usedCachedCloudManifests = cloud.length > 0;
    }
  }

  const localIds = new Set(local.map((m) => m.id));
  const allManifests = [...local, ...cloud.filter((m) => !localIds.has(m.id))];

  const anySource = Boolean(localManifests) || usedCachedLocalManifests
    || Boolean(cloudManifests) || usedCachedCloudManifests;
  // Persist on expiry too, even with no source data at all — the stored
  // snapshot must shed the expired local entries or the dashboard's
  // storage-fallback (and the next replay) would resurrect them.
  if (anySource || localExpired) {
    await setChangedStorageValues({
      [APP_SOURCES_KEY]: buildSourceMap(allManifests),
      [APP_MANIFESTS_KEY]: allManifests,
    });
    // Opportunistically refresh the userscript source cache so userscripts can
    // re-register on SW restart even when the source is unreachable.
    await refreshUserscriptSourceCache(allManifests);
  }

  return {
    reachable: anySource,
    localReachable: Boolean(localManifests),
    cloudReachable: Boolean(cloudManifests),
    usedCachedLocalManifests,
    manifests: allManifests,
  };
}

/**
 * Cache userscript source bytes per-app, keyed by manifest _hash. Removes
 * stale entries for apps that are no longer present.
 */
async function refreshUserscriptSourceCache(manifests: SourcedManifest[]): Promise<void> {
  const cache = await readSourceCache();
  const currentIds = new Set(manifests.map((m) => m.id));
  let dirty = false;

  for (const id of Object.keys(cache)) {
    if (!currentIds.has(id)) { delete cache[id]; dirty = true; }
  }

  for (const manifest of manifests) {
    const hash = (manifest as any)._hash as string | undefined;
    if (!hash) continue;
    const cached = cache[manifest.id];
    if (cached?.hash === hash) continue;
    const userscripts: Record<string, string> = {};
    let allOk = true;
    for (const us of manifest.userscripts || []) {
      try {
        userscripts[us.file] = await fetchUserscriptFromServer(manifest, us.file);
      } catch {
        allOk = false;
        break;
      }
    }
    if (!allOk) continue;
    cache[manifest.id] = { hash, userscripts };
    dirty = true;
  }

  if (dirty) await writeSourceCache(cache);
}

class SourceUnreachableError extends Error {
  constructor(public sourceUrl: string, cause: unknown) {
    super(`source ${sourceUrl} unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function fetchUserscriptFromServer(manifest: SourcedManifest, file: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchAppSource(
      manifest._source,
      `${manifest._source.url}/api/apps/${manifest.id}/userscript?file=${encodeURIComponent(file)}`,
    );
  } catch (e) {
    throw new SourceUnreachableError(manifest._source.url, e);
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {}
    throw new Error(`${manifest.id}/${file}: ${detail}`);
  }
  return await res.text();
}

/**
 * Fetch a userscript's source, preferring live source and falling back to
 * the on-disk cache when the source is unreachable.
 */
async function fetchUserscriptSource(manifest: SourcedManifest, file: string): Promise<string> {
  try {
    return await fetchUserscriptFromServer(manifest, file);
  } catch (e) {
    if (e instanceof SourceUnreachableError) {
      const cache = await readSourceCache();
      const cached = cache[manifest.id]?.userscripts?.[file];
      if (cached !== undefined) return cached;
    }
    throw e;
  }
}

/**
 * Register all userscripts from all installed apps via chrome.userScripts API.
 *
 * Serialized: the body reads the current registration (getScripts) and then
 * conditionally swaps it (unregister + register), so two overlapping calls
 * (boot-time cached replay racing the fresh daemon load) could both decide to
 * swap and the second register throws "Duplicate script ID". The chain runs
 * callers one at a time; each caller still sees its own call's result/error.
 */
let registerChain: Promise<void> = Promise.resolve();

export function registerAllUserscripts(manifests: SourcedManifest[]): Promise<void> {
  const run = registerChain.then(() => doRegisterAllUserscripts(manifests));
  registerChain = run.catch(() => {});
  return run;
}

async function doRegisterAllUserscripts(manifests: SourcedManifest[]): Promise<void> {
  const scripts: chrome.userScripts.RegisteredUserScript[] = [];
  const worldIds = new Set<string>();
  const unreachableSources = new Set<string>();

  const seenAppIds = new Set<string>();

  outer: for (const manifest of manifests) {
    if (!manifest.userscripts?.length) continue;
    // Same app id from two sources would produce duplicate script ids and
    // fail the whole register() batch — first source wins.
    if (seenAppIds.has(manifest.id)) {
      logger.warn('airglow', `duplicate manifest for '${manifest.id}' — skipping its userscripts`);
      continue;
    }
    seenAppIds.add(manifest.id);

    const sdkCode = buildSdkCode(manifest.id, 'userscript');
    const worldId = `airglow:${manifest.id}`;

    for (const us of manifest.userscripts) {
      if (unreachableSources.has(manifest._source.url)) continue outer;
      try {
        const appCode = await fetchUserscriptSource(manifest, us.file);
        // sourceURL tags the script so ErrorEvent.filename and stack frames
        // start with "airglow-app://...", letting the SDK distinguish app
        // errors from host-page noise (e.g. Outlook's ResizeObserver loop).
        const sourceUrl = `//# sourceURL=airglow-app://${manifest.id}/${us.file}\n`;
        // A MAIN-world script runs in the page's own realm — the only way to
        // patch page globals (window.fetch, WebSocket, …) and the one path that
        // survives a strict page CSP. It gets NO `airglow.*` bridge (that lives
        // in the isolated world), so the SDK prelude and worldId are omitted.
        const mainWorld = us.world === 'MAIN';
        if (!mainWorld) worldIds.add(worldId);
        scripts.push({
          id: `${manifest.id}__${us.file.replace(/[\/\.]/g, '_')}`,
          matches: us.matches,
          allFrames: us.allFrames ?? false,
          js: [{ code: sourceUrl + (mainWorld ? '' : sdkCode) + appCode }],
          runAt: (us.runAt || 'document_idle') as 'document_start' | 'document_end' | 'document_idle',
          ...(mainWorld ? { world: 'MAIN' as const } : { world: 'USER_SCRIPT' as const, worldId }),
        });
      } catch (e: any) {
        if (e instanceof SourceUnreachableError) {
          if (!unreachableSources.has(e.sourceUrl)) {
            unreachableSources.add(e.sourceUrl);
            logger.warn('airglow', `source ${e.sourceUrl} unreachable; skipping userscript registration`);
          }
          continue outer;
        }
        const msg = e?.message || String(e);
        console.error(`[airglow] Failed to load userscript ${manifest.id}/${us.file}:`, e);
        logger.error(manifest.id, `Build failed for ${us.file}: ${msg}`);
      }
    }
  }

  await trackAppsRegistered(manifests).catch((e) =>
    logger.warn('airglow', `trackAppsRegistered failed: ${e instanceof Error ? e.message : String(e)}`),
  );

  // Swap only when the desired set differs from what's already registered.
  // Sources were fetched above, before unregister(), so a page loading
  // mid-call never hits an empty-registration window; identical sets
  // (offline cache replay, forced no-change loads) skip the churn entirely.
  const scriptKey = (s: chrome.userScripts.RegisteredUserScript) =>
    JSON.stringify([s.matches, s.allFrames ?? false, s.runAt, s.world, s.worldId, s.js?.map((j) => j.code)]);
  const currentScripts = await chrome.userScripts.getScripts().catch(() => []);
  const unchanged = currentScripts.length === scripts.length
    && (() => {
      const current = new Map(currentScripts.map((s) => [s.id, scriptKey(s)]));
      return scripts.every((s) => current.get(s.id!) === scriptKey(s));
    })();

  if (!unchanged) {
    await chrome.userScripts.unregister();
    if (scripts.length > 0) {
      for (const worldId of worldIds) {
        await chrome.userScripts.configureWorld({
          worldId,
          // 'unsafe-eval' lets the app's own isolated world run new Function/eval.
          // Required for `eval --app <id>` (background's evalBody wraps code in
          // `new Function`): the world is locked at instantiation, so widening its
          // CSP later (evalInAppWorld) is ignored once the userscript has run on a
          // tab. Scope is the app's own USER_SCRIPT world — isolated from the page
          // and from other apps — so this does not relax the host page's CSP.
          csp: "script-src 'self' 'unsafe-eval'",
          messaging: true,
        });
      }
      await chrome.userScripts.register(scripts);
      logger.info('airglow', `registered ${scripts.length} userscript(s)`);
      // Registrations take effect on the next navigation. Open tabs are never
      // auto-reloaded — the user refreshes when they want the new code.
    }
  }

  // Iframe keyboard forwarder (platform feature, see comment in original).
  const FORWARDER_ID = 'airglow-iframe-key-forwarder';
  try { await chrome.scripting.unregisterContentScripts({ ids: [FORWARDER_ID] }); } catch {}
  try {
    await chrome.scripting.registerContentScripts([{
      id: FORWARDER_ID,
      matches: ['<all_urls>'],
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: 'document_idle',
      js: ['iframe-key-forwarder.js'],
    }]);
  } catch (e: any) {
    logger.warn('airglow', `iframe key forwarder registration failed: ${e.message}`);
  }

}

export async function runStartupScripts(manifests: SourcedManifest[]): Promise<void> {
  const startupManifests = manifests.filter((m) => m.startup);
  if (startupManifests.length === 0) return;

  for (const manifest of startupManifests) {
    try {
      const res = await fetchAppSource(
        manifest._source,
        `${manifest._source.url}/api/apps/${manifest.id}/userscript?file=${encodeURIComponent(manifest.startup!)}&format=esm`,
      );
      if (!res.ok) {
        logger.warn(manifest.id, `failed to fetch startup: ${res.status}`);
        continue;
      }
      const code = await res.text();
      const sdk = buildSdkCode(manifest.id, 'startup');
      await runStartupDirect(manifest.id, code, sdk);
      logger.info(manifest.id, 'startup script ran');
    } catch (e) {
      logger.error(manifest.id, `startup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function runStartupDirect(appId: string, code: string, sdk: string): Promise<void> {
  await ensureAirglowOffscreenDocument('Run app startup scripts in sandboxed iframe');

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error(`startup timeout for ${appId}`));
    }, 10000);
    const listener = (msg: any) => {
      if (msg?.type === 'airglow:startup:done' && msg.appId === appId) {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        if (msg.ok) resolve();
        else reject(new Error(msg.error));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    sendRuntimeMessageWhenReady({ type: 'airglow:startup:run', appId, code, sdk }).catch((error) => {
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      reject(error);
    });
  });

  // Keep the shared local-execution runtime alive: app UI RPC calls reuse the
  // same offscreen document and may already be queued behind a startup job.
}

