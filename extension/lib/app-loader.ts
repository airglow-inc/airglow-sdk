/**
 * App loader — loads manifests from the local daemon (the only app source)
 * and registers userscripts.
 */

import { buildSdkCode } from './airglow-sdk';
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

async function getLocalSource(): Promise<AppSource> {
  const result = await chrome.storage.local.get(DAEMON_ORIGIN_KEY);
  const origin = typeof result[DAEMON_ORIGIN_KEY] === 'string' && result[DAEMON_ORIGIN_KEY]
    ? (result[DAEMON_ORIGIN_KEY] as string)
    : DEFAULT_DAEMON_ORIGIN;
  return { url: origin, type: 'local' };
}

const APP_SOURCES_KEY = '__app_sources';
export const APP_MANIFESTS_KEY = '__app_manifests';
// Per-app userscript source cache. Keyed by appId; hash-gated so we only
// re-fetch when the manifest's _hash actually changes. Lets the extension
// re-register userscripts on SW restart while the source is offline.
const APP_SOURCE_CACHE_KEY = '__app_sources_cache';

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

async function fetchAppSource(source: AppSource, url: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(LOCAL_SOURCE_TIMEOUT_MS) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`app source ${source.url} unreachable: ${message}`);
  }
}

async function fetchSourceManifests(source: AppSource): Promise<AppManifest[] | null> {
  try {
    const res = await fetchAppSource(source, `${source.url}/api/apps/manifests`);
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

async function getCachedLocalManifests(): Promise<SourcedManifest[]> {
  const stored = await chrome.storage.local.get(APP_MANIFESTS_KEY);
  const cached = stored[APP_MANIFESTS_KEY];
  if (!Array.isArray(cached)) return [];
  return cached.filter((manifest): manifest is SourcedManifest =>
    Boolean(manifest && typeof manifest === 'object' && (manifest as SourcedManifest)._source),
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
  // True if the daemon provided manifests (live OR fall-back-cached).
  reachable: boolean;
  localReachable: boolean;
  // True when the daemon was unreachable and we replayed the prior snapshot.
  usedCachedLocalManifests: boolean;
  manifests: SourcedManifest[];
}

/**
 * Load manifests from the local daemon. Falls back to the cached snapshot
 * when the daemon is offline so userscripts keep working across SW restarts.
 */
export async function loadAppManifests(): Promise<LoadResult> {
  const localSource = await getLocalSource();
  const localManifests = await fetchSourceManifests(localSource);

  let usedCachedLocalManifests = false;
  let allManifests: SourcedManifest[];

  if (localManifests) {
    allManifests = resolveAppManifests(localSource, localManifests);
  } else {
    allManifests = resolveAppManifests(localSource, await getCachedLocalManifests());
    usedCachedLocalManifests = allManifests.length > 0;
  }

  if (localManifests || usedCachedLocalManifests) {
    await setChangedStorageValues({
      [APP_SOURCES_KEY]: buildSourceMap(allManifests),
      [APP_MANIFESTS_KEY]: allManifests,
    });
    // Opportunistically refresh the userscript source cache so userscripts can
    // re-register on SW restart even when the source is unreachable.
    await refreshUserscriptSourceCache(allManifests);
  }

  return {
    reachable: Boolean(localManifests) || usedCachedLocalManifests,
    localReachable: Boolean(localManifests),
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
 */
export async function registerAllUserscripts(manifests: SourcedManifest[], changedAppIds?: string[], opts?: { skipReload?: boolean }): Promise<void> {
  await chrome.userScripts.unregister();

  const scripts: chrome.userScripts.RegisteredUserScript[] = [];
  const worldIds = new Set<string>();
  const unreachableSources = new Set<string>();

  outer: for (const manifest of manifests) {
    if (!manifest.userscripts?.length) continue;

    const sdkCode = buildSdkCode(manifest.id, 'userscript');
    const worldId = `airglow:${manifest.id}`;
    worldIds.add(worldId);

    for (const us of manifest.userscripts) {
      if (unreachableSources.has(manifest._source.url)) continue outer;
      try {
        const appCode = await fetchUserscriptSource(manifest, us.file);
        // sourceURL tags the script so ErrorEvent.filename and stack frames
        // start with "airglow-app://...", letting the SDK distinguish app
        // errors from host-page noise (e.g. Outlook's ResizeObserver loop).
        const sourceUrl = `//# sourceURL=airglow-app://${manifest.id}/${us.file}\n`;
        scripts.push({
          id: `${manifest.id}__${us.file.replace(/[\/\.]/g, '_')}`,
          matches: us.matches,
          allFrames: us.allFrames ?? false,
          js: [{ code: sourceUrl + sdkCode + appCode }],
          runAt: (us.runAt || 'document_idle') as 'document_start' | 'document_end' | 'document_idle',
          world: 'USER_SCRIPT',
          worldId,
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

  if (scripts.length > 0) {
    for (const worldId of worldIds) {
      await chrome.userScripts.configureWorld({
        worldId,
        csp: "script-src 'self'",
        messaging: true,
      });
    }
    await chrome.userScripts.register(scripts);
    logger.info('airglow', `registered ${scripts.length} userscript(s)`);

    if (!opts?.skipReload) {
      const reloadScripts = changedAppIds
        ? scripts.filter((s) => changedAppIds.some((id) => s.id.startsWith(id + '__')))
        : scripts;
      const reloadMatches = reloadScripts.flatMap((s) => s.matches ?? []);
      if (reloadMatches.length > 0) {
        const tabs = await chrome.tabs.query({});
        let reloaded = 0;
        for (const tab of tabs) {
          if (!tab.url || !tab.id) continue;
          const matches = reloadMatches.some((p) => {
            const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
            return re.test(tab.url!);
          });
          if (matches) { chrome.tabs.reload(tab.id); reloaded++; }
        }
        if (reloaded > 0) logger.info('airglow', `reloaded ${reloaded} tab(s) for userscript injection`);
      }
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

