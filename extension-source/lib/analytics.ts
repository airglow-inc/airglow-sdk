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
import { USER_EMAIL_KEY, normalizeUserEmail } from './airglow-identity';

const INSTALLED_FLAG_KEY = '__airglow_installed_tracked';
const IDENTIFIED_FLAG_KEY = '__airglow_identified_tracked';
const IDENTIFIED_EMAIL_KEY = '__airglow_identified_tracked_email';
const APPS_REGISTERED_KEY = '__airglow_apps_registered';

export type AnalyticsPropertyValue =
  | string
  | number
  | boolean
  | null
  | AnalyticsPropertyValue[]
  | { [key: string]: AnalyticsPropertyValue };

type AppAnalyticsManifest = {
  id: string;
  startup?: unknown;
  serverFunctions?: unknown;
  _serverFunctions?: unknown;
  _hasUi?: unknown;
  userscripts?: unknown;
  _sourceType?: string;
};

export type DashboardPage = 'apps' | 'logs';

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function normalizeAppSourceType(value: string | undefined): string {
  return value === 'local' || value === 'cloud' ? value : 'unknown';
}

function appRegistrationProperties(app: AppAnalyticsManifest): Record<string, AnalyticsPropertyValue> {
  const serverFunctionCount = arrayCount(app.serverFunctions || app._serverFunctions);
  const userscriptCount = arrayCount(app.userscripts);
  return {
    app_id: app.id,
    app_source_type: normalizeAppSourceType(app._sourceType),
    has_ui: app._hasUi === true,
    has_startup: typeof app.startup === 'string' && app.startup.trim().length > 0,
    has_server_functions: serverFunctionCount > 0,
    has_userscripts: userscriptCount > 0,
  };
}

function appEventProperties(appId: string): Record<string, AnalyticsPropertyValue> {
  return { app_id: appId };
}

/** Dedup'd via storage after PostHog accepts the event. */
export async function trackInstalled(): Promise<void> {
  const stored = await chrome.storage.local.get(INSTALLED_FLAG_KEY);
  if (stored[INSTALLED_FLAG_KEY]) return;
  await posthog.capture('Extension Installed');
  await chrome.storage.local.set({ [INSTALLED_FLAG_KEY]: Date.now() });
}

/** Refreshes person traits and emits `User Identified` once per email value. */
export async function trackIdentified(emailValue?: unknown): Promise<void> {
  const stored = await chrome.storage.local.get([USER_EMAIL_KEY, IDENTIFIED_EMAIL_KEY]);
  const email = normalizeUserEmail(emailValue) || normalizeUserEmail(stored[USER_EMAIL_KEY]);
  if (!email) return;

  await posthog.identify();

  if (normalizeUserEmail(stored[IDENTIFIED_EMAIL_KEY]) === email) return;
  await posthog.capture('User Identified');
  await chrome.storage.local.set({
    [IDENTIFIED_FLAG_KEY]: Date.now(),
    [IDENTIFIED_EMAIL_KEY]: email,
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
export async function trackAppsRegistered(apps: AppAnalyticsManifest[]): Promise<void> {
  const current = [...apps]
    .map(appRegistrationProperties)
    .sort((a, b) => String(a.app_id).localeCompare(String(b.app_id)));
  const currentIds = current.map((app) => String(app.app_id));
  const stored = await chrome.storage.local.get(APPS_REGISTERED_KEY);
  const previous = Array.isArray(stored[APPS_REGISTERED_KEY])
    ? stored[APPS_REGISTERED_KEY] as unknown[]
    : [];
  if (JSON.stringify(previous) === JSON.stringify(current)) return;
  try {
    await posthog.identify({ apps_registered: currentIds });
  } catch (e) {
    logger.warn('airglow', `posthog identify (apps_registered) failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await posthog.capture('Apps Registered', {
    apps: currentIds,
    app_properties: current,
    count: current.length,
  });
  await chrome.storage.local.set({ [APPS_REGISTERED_KEY]: current });
}

export async function trackUserscriptInjected(appId: string): Promise<void> {
  await posthog.capture('Userscript Injected', appEventProperties(appId));
}

export async function trackUiPageOpened(appId: string): Promise<void> {
  await posthog.capture('UI Page Opened', appEventProperties(appId));
}

export async function trackDashboardOpened(
  page: DashboardPage,
): Promise<void> {
  await posthog.capture('Dashboard Opened', { page });
}
