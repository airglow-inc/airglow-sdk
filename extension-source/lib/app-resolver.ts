/**
 * Pure manifest resolution: merges manifests from multiple app sources
 * (local dev server, cloud) into the runtime + inventory lists.
 *
 * - Runtime list (`resolveAppManifests`): one entry per appId. Local wins on
 *   collision so a developer's working copy shadows the published cloud app.
 * - Inventory list (`resolveAppInventoryManifests`): both copies kept, keyed
 *   by `${sourceType}:${id}`. Lets the dashboard show "this cloud app is
 *   shadowed by your local copy" with a badge.
 */

export type AppVisibility = 'public' | 'development' | 'private' | 'hidden';
export type AppSourceType = 'local' | 'cloud';

export interface AppManifest {
  id: string;
  slug?: string;
  name: string;
  version: string;
  description: string;
  tags?: string[];
  visibility?: AppVisibility;
  defaultEnabled?: boolean;
  startup?: string;
  capabilities?: string[];
  serverFunctions?: string[];
  userscripts?: { file: string; matches: string[]; allFrames?: boolean; runAt?: string }[];
  secrets?: Record<string, { scope?: string; label?: string }>;
  host_permissions?: string[];
  // Dev-server-injected on local source: names of `server/*.ts` RPC handlers.
  // Surfaced in the dashboard to warn when an app depends on the dev server.
  _serverFunctions?: string[];
  [key: string]: unknown;
}

export interface AppSource {
  url: string;
  type: AppSourceType;
}

export type SourcedManifest = AppManifest & {
  _source: AppSource;
  _sourceType: AppSourceType;
};

export type SourceManifestSet = {
  source: AppSource;
  manifests: AppManifest[];
};

function isManifestEnabled(_source: AppSource, manifest: AppManifest): boolean {
  return manifest.visibility !== 'hidden';
}

function resolveOne(source: AppSource, manifest: AppManifest): SourcedManifest | null {
  if (!isManifestEnabled(source, manifest)) return null;
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) return null;

  return {
    ...manifest,
    id: manifest.id.trim(),
    _source: source,
    _sourceType: source.type,
  };
}

export type AppSourceOverrides = Record<string, AppSourceType>;

/**
 * Runtime resolution: deduplicated by appId. Local sources win on collision
 * by default so a developer's working copy shadows the cloud version. The
 * user can explicitly opt-in to the cloud copy via `sourceOverrides[appId]`
 * — typically set by clicking "Use cloud version" on a shadowed row.
 */
export function resolveAppManifests(
  inputSets: SourceManifestSet[],
  sourceOverrides?: AppSourceOverrides,
): SourcedManifest[] {
  // Which local appIds will be excluded from the runtime list because the
  // user has explicitly chosen the cloud copy.
  const cloudOverrideIds = new Set<string>();
  if (sourceOverrides) {
    for (const [appId, type] of Object.entries(sourceOverrides)) {
      if (type === 'cloud') cloudOverrideIds.add(appId);
    }
  }

  // Local ids that claim the runtime slot (i.e. local has them AND user
  // hasn't overridden to cloud).
  const localSourceAppIds = new Set<string>();
  for (const input of inputSets) {
    if (input.source.type !== 'local') continue;
    for (const manifest of input.manifests) {
      if (typeof manifest.id !== 'string') continue;
      const id = manifest.id.trim();
      if (!id) continue;
      if (cloudOverrideIds.has(id)) continue;
      if (isManifestEnabled(input.source, manifest)) {
        localSourceAppIds.add(id);
      }
    }
  }

  const sortedInputs = [...inputSets].sort((a, b) => {
    if (a.source.type === b.source.type) return 0;
    return a.source.type === 'local' ? -1 : 1;
  });

  const byAppId = new Map<string, SourcedManifest>();
  for (const input of sortedInputs) {
    for (const manifest of input.manifests) {
      const rawSourceAppId = typeof manifest.id === 'string' ? manifest.id.trim() : '';
      // Local manifests with a cloud override don't claim the slot.
      if (input.source.type === 'local' && cloudOverrideIds.has(rawSourceAppId)) continue;
      if (input.source.type !== 'local' && localSourceAppIds.has(rawSourceAppId)) continue;

      const resolved = resolveOne(input.source, manifest);
      if (!resolved) continue;
      if (!byAppId.has(resolved.id)) {
        byAppId.set(resolved.id, resolved);
      }
    }
  }

  return Array.from(byAppId.values());
}

/**
 * Inventory: keeps both copies of an app that exists in multiple sources.
 * Keyed by `${sourceType}:${id}` so the dashboard can render local + cloud
 * rows side-by-side and badge the shadowed one.
 */
export function resolveAppInventoryManifests(inputSets: SourceManifestSet[]): SourcedManifest[] {
  const bySourceAppId = new Map<string, SourcedManifest>();
  for (const input of inputSets) {
    for (const manifest of input.manifests) {
      const resolved = resolveOne(input.source, manifest);
      if (!resolved) continue;
      const inventoryKey = `${resolved._sourceType}:${resolved.id}`;
      if (!bySourceAppId.has(inventoryKey)) {
        bySourceAppId.set(inventoryKey, resolved);
      }
    }
  }
  return Array.from(bySourceAppId.values());
}

export function buildSourceMap(manifests: SourcedManifest[]): Record<string, AppSource> {
  const sourceMap: Record<string, AppSource> = {};
  for (const manifest of manifests) {
    sourceMap[manifest.id] = manifest._source;
  }
  return sourceMap;
}
