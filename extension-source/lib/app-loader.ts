/**
 * App loader — discovers the local dev server, loads manifests, registers userscripts.
 */

import { buildSdkCode } from './airglow-sdk';
import { logger } from './logger';
import { trackAppsRegistered } from './analytics';

export type AppVisibility = 'public' | 'development' | 'hidden';

export interface AppManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  tags?: string[];
  visibility?: AppVisibility;
  // First-encounter default. When false, the extension adds the app to its
  // __disabled_apps set the first time it sees the id, so the app ships
  // disabled. Once seen, the user's dashboard toggle is authoritative and
  // this field is ignored.
  defaultEnabled?: boolean;
  startup?: string;
  userscripts?: { file: string; matches: string[]; allFrames?: boolean; runAt?: string }[];
  secrets?: Record<string, { scope: string; label?: string }>;
  host_permissions?: string[];
}

export interface AppSource {
  url: string;
  type: 'local';
}

export type SourcedManifest = AppManifest & { _source: AppSource };

const DEV_PORT_KEY = '__dev_port';
const DEFAULT_DEV_PORT = 3222;

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

const APP_SOURCES_KEY = '__app_sources';
const APP_MANIFESTS_KEY = '__app_manifests';

function isManifestEnabled(manifest: AppManifest): boolean {
  return manifest.visibility !== 'hidden';
}

/**
 * Return the local source if the dev server is reachable.
 */
async function discoverSources(): Promise<AppSource[]> {
  const source = await getLocalSource();
  try {
    const res = await fetch(`${source.url}/api/apps/manifests`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    return [source];
  } catch {
    return [];
  }
}

export interface LoadResult {
  reachable: boolean;
  manifests: SourcedManifest[];
}

/**
 * Load manifests from the local dev server.
 * Stores source map in chrome.storage.local for app-shell to read.
 */
export async function loadAppManifests(): Promise<LoadResult> {
  const sources = await discoverSources();
  if (sources.length === 0) return { reachable: false, manifests: [] };

  const manifestsById = new Map<string, SourcedManifest>();
  const sourceMap: Record<string, AppSource> = {};

  await Promise.all(
    sources.map(async (source) => {
      try {
        const res = await fetch(`${source.url}/api/apps/manifests`);
        if (!res.ok) return;
        const manifests: AppManifest[] = await res.json();
        for (const manifest of manifests) {
          if (!isManifestEnabled(manifest)) continue;
          if (manifestsById.has(manifest.id)) continue;
          const sourcedManifest = { ...manifest, _source: source };
          manifestsById.set(manifest.id, sourcedManifest);
          sourceMap[manifest.id] = source;
        }
      } catch (error) {
        logger.warn('airglow', `manifest fetch failed for ${source.url}: ${error}`);
      }
    }),
  );

  const allManifests = Array.from(manifestsById.values());

  // Persist source and manifest snapshots for app-shell and message handler.
  await chrome.storage.local.set({
    [APP_SOURCES_KEY]: sourceMap,
    [APP_MANIFESTS_KEY]: allManifests,
  });

  return { reachable: true, manifests: allManifests };
}

class SourceUnreachableError extends Error {
  constructor(public sourceUrl: string, cause: unknown) {
    super(`source ${sourceUrl} unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * Fetch a userscript's source code from the correct source server.
 */
async function fetchUserscriptSource(manifest: SourcedManifest, file: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(
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
 * Register all userscripts from all installed apps via chrome.userScripts API.
 */
export async function registerAllUserscripts(manifests: SourcedManifest[], changedAppIds?: string[], opts?: { skipReload?: boolean }): Promise<void> {
  await chrome.userScripts.unregister();

  const scripts: chrome.userScripts.RegisteredUserScript[] = [];
  const worldIds = new Set<string>();
  const unreachableSources = new Set<string>();

  outer: for (const manifest of manifests) {
    if (!manifest.userscripts?.length) continue;

    const sdkCode = buildSdkCode(manifest.id);
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

  // Inventory snapshot: only fires when the set of app ids actually changes,
  // so this is a no-op on the common "register pass found the same apps" path.
  trackAppsRegistered(manifests.map((m) => m.id)).catch((e) =>
    logger.warn('airglow', `trackAppsRegistered failed: ${e instanceof Error ? e.message : String(e)}`),
  );

  if (scripts.length > 0) {
    // Configure each app's world separately (isolated JS globals)
    for (const worldId of worldIds) {
      await chrome.userScripts.configureWorld({
        worldId,
        csp: "script-src 'self'",
        messaging: true,
      });
    }
    await chrome.userScripts.register(scripts);
    logger.info('airglow', `registered ${scripts.length} userscript(s)`);

    // Only reload tabs matching changed apps (or all if changedAppIds is undefined)
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

  // Register iframe keyboard forwarder as a platform feature.
  // chrome.userScripts can't inject into about:blank/srcdoc iframes (no matchOriginAsFallback).
  // chrome.scripting.registerContentScripts CAN, so we register a tiny forwarder that
  // relays modifier+key events from child frames to the top frame via postMessage.
  // Any app userscript can listen for __airglowKeyForward messages to handle iframe shortcuts.
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

  // Pre-populate client secrets from .env
  for (const manifest of manifests) {
    await loadDevSettings(manifest);
  }
}

/**
 * Run startup.ts for all apps that declare one.
 */
export async function runStartupScripts(manifests: SourcedManifest[]): Promise<void> {
  const startupManifests = manifests.filter((m) => m.startup);
  if (startupManifests.length === 0) return;

  for (const manifest of startupManifests) {
    try {
      const res = await fetch(
        `${manifest._source.url}/api/apps/${manifest.id}/userscript?file=${encodeURIComponent(manifest.startup!)}&format=esm`,
      );
      if (!res.ok) {
        console.error(`[airglow] Failed to fetch startup for ${manifest.id}: ${res.status}`);
        continue;
      }
      const code = await res.text();
      const sdk = buildSdkCode(manifest.id);
      await runStartupDirect(manifest.id, code, sdk);
      console.log(`[airglow] Ran startup for ${manifest.id}`);
    } catch (e) {
      console.error(`[airglow] Startup failed for ${manifest.id}:`, e);
    }
  }
}

async function runStartupDirect(appId: string, code: string, sdk: string): Promise<void> {
  try {
    await (chrome.offscreen as any).createDocument({
      url: 'startup-runner.html',
      reasons: ['DOM_PARSER'] as any,
      justification: 'Run app startup scripts in sandboxed iframe',
    });
  } catch (e: any) {
    if (!e.message?.includes('already exists')) throw e;
  }

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
    chrome.runtime.sendMessage({ type: 'airglow:startup:run', appId, code, sdk });
  });

  try { await (chrome.offscreen as any).closeDocument(); } catch {}
}

const DEV_SECRET_PREFIX = 'airglow:dev-secret:';
const USER_SECRET_PREFIX = 'airglow:secret:';

async function loadDevSettings(manifest: SourcedManifest): Promise<void> {
  if (manifest._source.type !== 'local') return;

  try {
    const res = await fetch(`${manifest._source.url}/api/apps/${manifest.id}/settings`);
    if (!res.ok) return;
    const settings: Record<string, string> = await res.json();

    // All manifest secrets are client-scoped
    const clientKeys = new Set(Object.keys(manifest.secrets || {}));

    const keysToWrite = Object.keys(settings).filter((k) => clientKeys.has(k));
    if (keysToWrite.length === 0) return;

    // Check which keys the user already set via dashboard
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
