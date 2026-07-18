// Server-driven announcement banner. The cloud serves the *current* set of
// announcements as DATA only — MV3-clean: the shipped bundle decides how to
// render and which one to show; the server merely supplies content + a few
// gating fields. No remote code, ever. Edge Config is the serving store (see
// airglow-cloud/app/api/announcement); the background polls it on a
// chrome.alarms schedule and caches the array, the UIs read the cache.

export interface Announcement {
  id: string;
  // Epoch ms. Anchors new-user visibility: an `existing`-audience announcement
  // is shown only to installs that predate it (publishedAt > installedAt).
  publishedAt: number;
  title: string;
  // Markdown (text + links only; rendered through a sanitizing renderer that
  // emits no raw HTML — keeps us on the data side of the remote-code line).
  body: string;
  severity?: 'info' | 'critical';
  // 'existing' (default): only users who installed before publishedAt see it —
  // for time-relevant/incident notices. 'all': everyone, incl. future installs.
  audience?: 'existing' | 'all';
  // Optional: only show on extension versions >= this (dotted numeric).
  minVersion?: string;
  // Optional: only show when the installed native host's version is <= this
  // (dotted numeric). The recovery channel for hosts with a broken self-update:
  // the host binary can't be reached remotely, but the extension can tell its
  // user what to run. Skipped when the daemon is offline (host version unknown).
  maxHostVersion?: string;
  // Optional epoch ms; hidden once now >= expiresAt.
  expiresAt?: number;
}

export const ANNOUNCEMENTS_CACHE_KEY = '__announcements_cache';
export const ANNOUNCEMENTS_DISMISSED_KEY = '__announcements_dismissed';
export const INSTALLED_AT_KEY = '__installed_at';

// a >= b, by dotted numeric version (missing parts = 0).
function versionGte(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

// Choose the one announcement to show: drop dismissed/expired/version-gated and
// (for `existing` audience) ones that predate this install, then take newest.
export function pickAnnouncement(
  list: Announcement[],
  opts: { installedAt: number; dismissed: string[]; version: string; now: number; hostVersion?: string | null },
): Announcement | null {
  const { installedAt, dismissed, version, now, hostVersion } = opts;
  const eligible = (Array.isArray(list) ? list : []).filter((a) => {
    if (!a || typeof a.id !== 'string' || typeof a.publishedAt !== 'number') return false;
    if (dismissed.includes(a.id)) return false;
    if (typeof a.expiresAt === 'number' && now >= a.expiresAt) return false;
    if (a.minVersion && !versionGte(version, a.minVersion)) return false;
    // host <= max ⇔ max >= host. Unknown host (daemon offline) → not shown.
    if (a.maxHostVersion && !(hostVersion && versionGte(a.maxHostVersion, hostVersion))) return false;
    const audience = a.audience ?? 'existing';
    if (audience !== 'all' && !(a.publishedAt > installedAt)) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.publishedAt - a.publishedAt);
  return eligible[0];
}
