/**
 * Client-side lifecycle tracking for the extension. Targets PostHog only.
 *
 * Dedup state lives in `chrome.storage.local`:
 *   `__airglow_installed_tracked` — set on the first install dispatch.
 *   `__airglow_identified_tracked` — set on the first valid email dispatch.
 *   `__airglow_apps_registered`   — last-shipped sorted app-id set; we only
 *                                   fire `Apps Registered` when this changes.
 */

import * as posthog from './posthog';
import { logger } from './logger';

const INSTALLED_FLAG_KEY = '__airglow_installed_tracked';
const IDENTIFIED_FLAG_KEY = '__airglow_identified_tracked';
const APPS_REGISTERED_KEY = '__airglow_apps_registered';

/** Fire-and-forget; dedup'd via storage. */
export async function trackInstalled(): Promise<void> {
  const stored = await chrome.storage.local.get(INSTALLED_FLAG_KEY);
  if (stored[INSTALLED_FLAG_KEY]) return;
  await chrome.storage.local.set({ [INSTALLED_FLAG_KEY]: Date.now() });
  posthog.capture('Extension Installed').catch((e) => {
    logger.warn('airglow', `posthog capture 'Extension Installed' failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}

/** Fire-and-forget; dedup'd via storage. Refreshes person traits with email. */
export async function trackIdentified(): Promise<void> {
  const stored = await chrome.storage.local.get(IDENTIFIED_FLAG_KEY);
  if (stored[IDENTIFIED_FLAG_KEY]) return;
  await chrome.storage.local.set({ [IDENTIFIED_FLAG_KEY]: Date.now() });
  posthog.identify().catch((e) => {
    logger.warn('airglow', `posthog identify failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  posthog.capture('User Identified').catch((e) => {
    logger.warn('airglow', `posthog capture 'User Identified' failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}

/**
 * Fire when the set of app ids in the user's workspace changes (install,
 * remove, rename). Ships the full sorted set every time so PostHog has both
 * a delta-shaped event and a live person property (`apps_registered`) for
 * inventory queries.
 *
 * Compared against `__airglow_apps_registered` in chrome.storage.local; no
 * network call when the set is unchanged. Expected lifetime volume is in the
 * single digits per user.
 */
export async function trackAppsRegistered(appIds: string[]): Promise<void> {
  const current = [...new Set(appIds)].sort();
  const stored = await chrome.storage.local.get(APPS_REGISTERED_KEY);
  const previous = Array.isArray(stored[APPS_REGISTERED_KEY])
    ? (stored[APPS_REGISTERED_KEY] as string[])
    : [];
  if (previous.length === current.length && previous.every((id, i) => id === current[i])) return;
  await chrome.storage.local.set({ [APPS_REGISTERED_KEY]: current });
  posthog.identify({ apps_registered: current }).catch((e) => {
    logger.warn('airglow', `posthog identify (apps_registered) failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  posthog.capture('Apps Registered', { apps: current, count: current.length }).catch((e) => {
    logger.warn('airglow', `posthog capture 'Apps Registered' failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}
