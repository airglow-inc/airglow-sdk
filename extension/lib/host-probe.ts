// React-free probe for the running daemon's version (healthz). Shared by the
// posthog $identify person properties, the announcement host-version gating,
// and the useHostVersion hook. Best effort: null when the daemon is offline.

const DAEMON_ORIGIN_KEY = '__daemon_origin';
const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:3222';
const LAST_HOST_VERSION_KEY = '__host_version_last';

export async function fetchHostVersion(): Promise<string | null> {
  try {
    const r = await chrome.storage.local.get(DAEMON_ORIGIN_KEY);
    const stored = r[DAEMON_ORIGIN_KEY];
    const origin = typeof stored === 'string' && stored ? stored : DEFAULT_DAEMON_ORIGIN;
    const res = await fetch(`${origin}/api/healthz`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json();
    const version = typeof body?.version === 'string' ? body.version : null;
    if (version) void chrome.storage.local.set({ [LAST_HOST_VERSION_KEY]: version });
    return version;
  } catch {
    return null;
  }
}

// Live version, falling back to the last one the daemon ever reported. For
// host-version announcement gating: a *dead* daemon (bricked install) can't
// answer, but whatever it last reported is what's still installed — and those
// users are exactly who a recovery banner must reach. After a reinstall the
// live probe answers again and immediately supersedes the cache.
export async function fetchHostVersionOrLast(): Promise<string | null> {
  const live = await fetchHostVersion();
  if (live) return live;
  const r = await chrome.storage.local.get(LAST_HOST_VERSION_KEY);
  return typeof r[LAST_HOST_VERSION_KEY] === 'string' ? r[LAST_HOST_VERSION_KEY] : null;
}
