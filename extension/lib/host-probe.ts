// React-free probe for the running daemon's version (healthz). Shared by the
// posthog $identify person properties, the announcement host-version gating,
// and the useHostVersion hook. Best effort: null when the daemon is offline.

const DAEMON_ORIGIN_KEY = '__daemon_origin';
const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:3222';

export async function fetchHostVersion(): Promise<string | null> {
  try {
    const r = await chrome.storage.local.get(DAEMON_ORIGIN_KEY);
    const stored = r[DAEMON_ORIGIN_KEY];
    const origin = typeof stored === 'string' && stored ? stored : DEFAULT_DAEMON_ORIGIN;
    const res = await fetch(`${origin}/api/healthz`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json();
    return typeof body?.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}
