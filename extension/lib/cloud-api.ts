// THE cloud URL. One backend (api.airglow.dev) carries everything remote —
// auth, agent + LLM gateways, feedback, config. Single resolution order:
//   1. runtime dev override (Settings → Cloud API URL, chrome.storage)
//   2. build-time env (forks pointing at their own deployment)
//   3. production default
// All cloud-bound code resolves through getCloudApiUrl(); never read the
// storage key or env directly. The daemon gets the same override via the
// background's `identity` message (its AIRGLOW_GATEWAY_URL), so extension and
// daemon always target the same server.

export const DEFAULT_CLOUD_API_URL = 'https://api.airglow.dev';

// Historical key name from when the override only covered the agent gateway —
// kept so existing profiles' settings survive.
export const CLOUD_API_URL_OVERRIDE_KEY = '__agent_gateway_url';

const CLOUD_API_URL = import.meta.env.WXT_CLOUD_API_URL || DEFAULT_CLOUD_API_URL;

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

// The baked-in URL, ignoring any runtime override. Only for UI that needs to
// show "what would the default be" — everything else wants getCloudApiUrl().
export function getDefaultCloudApiUrl(): string {
  return trimTrailingSlash(CLOUD_API_URL);
}

// `localhost` resolves to ::1 first while local dev servers bind 127.0.0.1
// only — fetch may fall back but iframe navigation won't. Normalize so every
// consumer (fetches, app UI iframes, the daemon's gateway URL) agrees.
function normalizeLocalhost(url: string): string {
  return url.replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1');
}

// The runtime dev override, '' when unset.
export async function getCloudApiOverride(): Promise<string> {
  const stored = await chrome.storage.local.get(CLOUD_API_URL_OVERRIDE_KEY);
  const value = stored[CLOUD_API_URL_OVERRIDE_KEY];
  return typeof value === 'string' ? normalizeLocalhost(trimTrailingSlash(value.trim())) : '';
}

export async function getCloudApiUrl(): Promise<string> {
  return (await getCloudApiOverride()) || getDefaultCloudApiUrl();
}

// Reachability probe against the cloud's /api/healthz. Resolves true only when
// the server answers `{ ok }` within the timeout — used by the dashboard to
// show a red dot when the cloud is down or the override URL is wrong. Never
// throws; any network/timeout/parse failure is reported as unreachable.
export async function checkCloudApiReachable(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(`${trimTrailingSlash(url)}/api/healthz`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.ok !== false;
  } catch {
    return false;
  }
}
