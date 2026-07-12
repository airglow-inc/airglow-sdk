/**
 * Pure manifest resolution for app sources (the local daemon and the cloud
 * catalog tier): drops hidden/invalid manifests, dedupes by appId, tags each
 * manifest with its source so downstream code knows where to fetch
 * userscripts/UI from.
 */

export type AppVisibility = 'public' | 'hidden';
export type AppSourceType = 'local' | 'cloud';

export interface AppManifest {
  id: string;
  slug?: string;
  name: string;
  version: string;
  description: string;
  visibility?: AppVisibility;
  defaultEnabled?: boolean;
  startup?: string;
  serverFunctions?: string[];
  userscripts?: { file: string; matches: string[]; allFrames?: boolean; runAt?: string }[];
  server_env?: Record<string, { label?: string }>;
  host_permissions?: string[];
  // App-source-injected: whether the app exposes a UI entrypoint.
  _hasUi?: boolean;
  // Daemon-injected: names of `server/*.ts` RPC handlers. Surfaced in the
  // dashboard to warn when an app depends on the daemon being up.
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

function resolveOne(source: AppSource, manifest: AppManifest): SourcedManifest | null {
  if (manifest.visibility === 'hidden') return null;
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) return null;

  return {
    ...manifest,
    id: manifest.id.trim(),
    _source: source,
    _sourceType: source.type,
  };
}

export function resolveAppManifests(source: AppSource, manifests: AppManifest[]): SourcedManifest[] {
  const byAppId = new Map<string, SourcedManifest>();
  for (const manifest of manifests) {
    const resolved = resolveOne(source, manifest);
    if (!resolved) continue;
    if (!byAppId.has(resolved.id)) {
      byAppId.set(resolved.id, resolved);
    }
  }
  return Array.from(byAppId.values());
}

export function buildSourceMap(manifests: SourcedManifest[]): Record<string, AppSource> {
  const sourceMap: Record<string, AppSource> = {};
  for (const manifest of manifests) {
    sourceMap[manifest.id] = manifest._source;
  }
  return sourceMap;
}
