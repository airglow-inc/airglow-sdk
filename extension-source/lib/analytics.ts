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

export type AnalyticsPropertyValue = string | number | boolean | null | string[];

type AppAnalyticsManifest = {
  id: string;
  name?: string;
  version?: string;
  visibility?: string;
  startup?: unknown;
  serverFunctions?: unknown;
  _serverFunctions?: unknown;
  rpcExecution?: string;
  userscripts?: unknown;
  host_permissions?: unknown;
  _sourceType?: string;
};

export type AppSeenSurface = 'dashboard_list' | 'dashboard_details' | 'page_edge_menu' | 'app_shell_edge_menu' | 'userscript_injected';
export type AppUiOpenSurface = 'dashboard_card' | 'dashboard_sidebar' | 'edge_menu' | 'page_redirect';
export type AppUseAction = 'rpc' | 'llm' | 'fetch' | 'open_window' | 'open_tab' | 'capture_tab' | 'app_action';
export type DashboardPage = 'apps' | 'logs';

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function normalizeAppSourceType(value: string | undefined): string {
  return value === 'local' || value === 'cloud' ? value : 'unknown';
}

function appAnalyticsProperties(
  app: AppAnalyticsManifest,
  extra: Record<string, AnalyticsPropertyValue> = {},
): Record<string, AnalyticsPropertyValue> {
  const serverFunctionCount = arrayCount(app.serverFunctions || app._serverFunctions);
  const userscriptCount = arrayCount(app.userscripts);
  const hostPermissionCount = arrayCount(app.host_permissions);
  return {
    app_id: app.id,
    app_name: app.name || app.id,
    app_source_type: normalizeAppSourceType(app._sourceType),
    app_version: app.version || null,
    app_visibility: app.visibility || null,
    has_ui: true,
    has_startup: typeof app.startup === 'string' && app.startup.trim().length > 0,
    has_server_functions: serverFunctionCount > 0,
    has_userscripts: userscriptCount > 0,
    has_host_permissions: hostPermissionCount > 0,
    server_function_count: serverFunctionCount,
    userscript_count: userscriptCount,
    host_permission_count: hostPermissionCount,
    rpc_execution: app.rpcExecution || null,
    ...extra,
  };
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

  try {
    await posthog.identify();
  } catch (e) {
    logger.warn('airglow', `posthog identify failed: ${e instanceof Error ? e.message : String(e)}`);
  }

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
export async function trackAppsRegistered(appIds: string[]): Promise<void> {
  const current = [...new Set(appIds)].sort();
  const stored = await chrome.storage.local.get(APPS_REGISTERED_KEY);
  const previous = Array.isArray(stored[APPS_REGISTERED_KEY])
    ? (stored[APPS_REGISTERED_KEY] as string[])
    : [];
  if (previous.length === current.length && previous.every((id, i) => id === current[i])) return;
  try {
    await posthog.identify({ apps_registered: current });
  } catch (e) {
    logger.warn('airglow', `posthog identify (apps_registered) failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await posthog.capture('Apps Registered', { apps: current, count: current.length });
  await chrome.storage.local.set({ [APPS_REGISTERED_KEY]: current });
}

export async function trackAppSeen(
  app: AppAnalyticsManifest,
  surface: AppSeenSurface,
  extra: Record<string, AnalyticsPropertyValue> = {},
): Promise<void> {
  await posthog.capture('App Seen', appAnalyticsProperties(app, { surface, ...extra }));
}

export async function trackAppUsed(
  app: AppAnalyticsManifest,
  action: AppUseAction,
  extra: Record<string, AnalyticsPropertyValue> = {},
): Promise<void> {
  await posthog.capture('App Used', appAnalyticsProperties(app, { action, ...extra }));
}

export async function trackAppUiOpened(
  app: AppAnalyticsManifest,
  surface: AppUiOpenSurface,
  extra: Record<string, AnalyticsPropertyValue> = {},
): Promise<void> {
  await posthog.capture(
    'App UI Opened',
    appAnalyticsProperties(app, { surface, ...extra }),
    { includeIdentityProperties: true },
  );
}

export async function trackDashboardOpened(
  page: DashboardPage,
  extra: Record<string, AnalyticsPropertyValue> = {},
): Promise<void> {
  await posthog.capture('Dashboard Opened', { page, ...extra });
}
