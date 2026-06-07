/**
 * App loader — discovers app sources (local dev server + cloud),
 * loads manifests, registers userscripts.
 */

import { buildSdkCode } from './airglow-sdk';
import { logger } from './logger';
import { trackAppsRegistered } from './analytics';
import { ensureAirglowOffscreenDocument, sendRuntimeMessageWhenReady } from './offscreen-runtime';
import { getCloudAppSourceUrl } from './app-source-config';
import {
  buildSourceMap,
  resolveAppInventoryManifests,
  resolveAppManifests,
  type AppManifest,
  type AppSource,
  type AppSourceOverrides,
  type SourcedManifest,
} from './app-resolver';

export type { AppManifest, AppSource, AppSourceOverrides, SourcedManifest, AppVisibility } from './app-resolver';

const DEV_PORT_KEY = '__dev_port';
const DEFAULT_DEV_PORT = 3222;
const LOCAL_SOURCE_TIMEOUT_MS = 4000;
const CLOUD_SOURCE_TIMEOUT_MS = 8000;
const CLOUD_SOURCE_RETRY_DELAYS_MS = [500, 1500, 3000];

async function getDevPort(): Promise<number> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEV_PORT_KEY, (result) => {
      resolve((result[DEV_PORT_KEY] as number) || DEFAULT_DEV_PORT);
    });
  });
}

async function getLocalSource(): Promise<AppSource> {
  const port = await getDevPort();
  return { url: `http://127.0.0.1:${port}`, type: 'local' };
}

function getCloudSource(): AppSource {
  return { url: getCloudAppSourceUrl(), type: 'cloud' };
}

const APP_SOURCES_KEY = '__app_sources';
export const APP_MANIFESTS_KEY = '__app_manifests';
export const APP_INVENTORY_MANIFESTS_KEY = '__app_inventory_manifests';
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

function isCloudSourceAllowed(source: AppSource): boolean {
  if (source.type !== 'cloud') return true;
  return source.url.startsWith('https://') || source.url.startsWith('http://127.0.0.1:');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function manifestFetchTimeoutMs(source: AppSource): number {
  return source.type === 'cloud' ? CLOUD_SOURCE_TIMEOUT_MS : LOCAL_SOURCE_TIMEOUT_MS;
}

function sourceRetryDelaysMs(source: AppSource): number[] {
  return source.type === 'cloud' ? CLOUD_SOURCE_RETRY_DELAYS_MS : [];
}

function shouldRetryAppSourceStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

async function fetchAppSource(source: AppSource, url: string, timeoutMs: number): Promise<Response> {
  const retryDelays = sourceRetryDelaysMs(source);
  let lastError = '';
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok && shouldRetryAppSourceStatus(res.status) && attempt < retryDelays.length) {
        lastError = `${source.type} app source ${source.url} returned ${res.status}`;
        await sleep(retryDelays[attempt]);
        continue;
      }
      return res;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < retryDelays.length) {
        await sleep(retryDelays[attempt]);
        continue;
      }
      throw new Error(`${source.type} app source ${source.url} unreachable after ${retryDelays.length + 1} attempt(s): ${lastError}`);
    }
  }
  throw new Error(`${source.type} app source ${source.url} unreachable: ${lastError}`);
}

async function fetchSourceManifestsOnce(source: AppSource): Promise<AppManifest[] | null> {
  const res = await fetchAppSource(source, `${source.url}/api/apps/manifests`, manifestFetchTimeoutMs(source));
  if (!res.ok) {
    logger.warn('airglow', `${source.type} app source ${source.url} returned ${res.status}`);
    return null;
  }
  const manifests = await res.json();
  return Array.isArray(manifests) ? manifests : null;
}

async function fetchSourceManifests(source: AppSource): Promise<AppManifest[] | null> {
  if (!isCloudSourceAllowed(source)) {
    logger.warn('airglow', `cloud source rejected: ${source.url}`);
    return null;
  }

  try {
    return await fetchSourceManifestsOnce(source);
  } catch (error) {
    logger.warn(
      'airglow',
      `${source.type} app source ${source.url} unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function getCachedLocalManifests(): Promise<AppManifest[]> {
  const stored = await chrome.storage.local.get(APP_INVENTORY_MANIFESTS_KEY);
  const cached = stored[APP_INVENTORY_MANIFESTS_KEY];
  if (!Array.isArray(cached)) return [];
  return cached.filter((manifest): manifest is SourcedManifest =>
    manifest && typeof manifest === 'object' && (manifest as SourcedManifest)._sourceType === 'local',
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
  // True if any source provided manifests (live OR fall-back-cached local).
  reachable: boolean;
  localReachable: boolean;
  cloudReachable: boolean;
  // True when local was unreachable and we replayed the prior cached snapshot.
  usedCachedLocalManifests: boolean;
  // Runtime list — deduplicated, local wins on collision.
  manifests: SourcedManifest[];
  // Inventory list — both copies kept when local + cloud share an id.
  inventoryManifests: SourcedManifest[];
}

/**
 * Load manifests from local + cloud sources in parallel. Falls back to the
 * cached local snapshot when the dev server is offline.
 *
 * `sourceOverrides`: per-appId opt-in to the cloud copy for shadowed apps.
 * Set via the dashboard's "Use cloud version" button. Without it, local
 * always wins on collision.
 */
export async function loadAppManifests(sourceOverrides?: AppSourceOverrides): Promise<LoadResult> {
  const localSource = await getLocalSource();
  const cloudSource = getCloudSource();
  const [localManifests, cloudManifests] = await Promise.all([
    fetchSourceManifests(localSource),
    fetchSourceManifests(cloudSource),
  ]);

  const inputSets: { source: AppSource; manifests: AppManifest[] }[] = [];
  let usedCachedLocalManifests = false;

  if (localManifests) {
    inputSets.push({ source: localSource, manifests: localManifests });
  } else {
    const cached = await getCachedLocalManifests();
    if (cached.length > 0) {
      inputSets.push({ source: localSource, manifests: cached });
      usedCachedLocalManifests = true;
    }
  }
  if (cloudManifests) inputSets.push({ source: cloudSource, manifests: cloudManifests });

  const allManifests = resolveAppManifests(inputSets, sourceOverrides);
  const inventoryManifests = resolveAppInventoryManifests(inputSets);
  const sourceMap = buildSourceMap(allManifests);

  await setChangedStorageValues({
    [APP_SOURCES_KEY]: sourceMap,
    [APP_MANIFESTS_KEY]: allManifests,
    [APP_INVENTORY_MANIFESTS_KEY]: inventoryManifests,
  });

  // Opportunistically refresh the userscript source cache so userscripts can
  // re-register on SW restart even when the source is unreachable.
  await refreshUserscriptSourceCache(allManifests);

  return {
    reachable: inputSets.length > 0,
    localReachable: Boolean(localManifests),
    cloudReachable: Boolean(cloudManifests),
    usedCachedLocalManifests,
    manifests: allManifests,
    inventoryManifests,
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
      manifestFetchTimeoutMs(manifest._source),
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

  for (const manifest of manifests) {
    await loadDevSettings(manifest);
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
        manifestFetchTimeoutMs(manifest._source),
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

const DEV_SECRET_PREFIX = 'airglow:dev-secret:';
const USER_SECRET_PREFIX = 'airglow:secret:';

async function loadDevSettings(manifest: SourcedManifest): Promise<void> {
  if (manifest._source.type !== 'local') return;

  try {
    const res = await fetch(`${manifest._source.url}/api/apps/${manifest.id}/settings`);
    if (!res.ok) return;
    const settings: Record<string, string> = await res.json();

    const clientKeys = new Set(Object.keys(manifest.secrets || {}));
    const keysToWrite = Object.keys(settings).filter((k) => clientKeys.has(k));
    if (keysToWrite.length === 0) return;

    const userKeys = keysToWrite.map((k) => `${USER_SECRET_PREFIX}${k}`);
    const existing = await chrome.storage.local.get(userKeys);

    const toStore: Record<string, string> = {};
    for (const key of keysToWrite) {
      if (existing[`${USER_SECRET_PREFIX}${key}`] !== undefined) {
        console.warn(`[airglow] CLIENT_${key} already set by user, ignoring .env value`);
        continue;
      }
      toStore[`${DEV_SECRET_PREFIX}${key}`] = settings[key];
    }

    if (Object.keys(toStore).length > 0) {
      await chrome.storage.local.set(toStore);
      console.log(`[airglow] Loaded ${Object.keys(toStore).length} dev secret(s) for ${manifest.id}`);
    }
  } catch (e) {
    console.error(`[airglow] Failed to load dev secrets for ${manifest.id}:`, e);
  }
}

export async function cleanupDevSecrets(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter((k) => k.startsWith(DEV_SECRET_PREFIX));
  if (toRemove.length === 0) return;
  await chrome.storage.local.remove(toRemove);
  console.log(`[airglow] Cleaned up ${toRemove.length} dev secret(s)`);
}
