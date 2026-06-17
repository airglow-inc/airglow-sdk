/**
 * Client-side lifecycle tracking for the extension. Targets PostHog only.
 *
 * Dedup state lives in `chrome.storage.local`:
 *   `__airglow_installed_tracked` — set on the first install dispatch.
 *   `__airglow_apps_registered`   — last-shipped sorted app-id set; we only
 *                                   fire `apps_registered` when this changes.
 */

import * as posthog from './posthog';
import { logger } from './logger';
import { USER_EMAIL_KEY, normalizeUserEmail } from './airglow-identity';

const INSTALLED_FLAG_KEY = '__airglow_installed_tracked';
const APPS_REGISTERED_KEY = '__airglow_apps_registered';
const HOST_INSTALLED_FLAG_KEY = '__airglow_host_installed_tracked';
const LOGIN_TRACKED_UID_KEY = '__airglow_login_tracked_uid';

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
  return value === 'local' ? value : 'unknown';
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
  await posthog.capture('extension_installed');
  await chrome.storage.local.set({ [INSTALLED_FLAG_KEY]: Date.now() });
}

/** Refreshes the PostHog person's `email` trait via $identify. */
export async function trackIdentified(emailValue?: unknown): Promise<void> {
  const stored = await chrome.storage.local.get([USER_EMAIL_KEY]);
  const email = normalizeUserEmail(emailValue) || normalizeUserEmail(stored[USER_EMAIL_KEY]);
  if (!email) return;
  await posthog.identify();
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
  await posthog.capture('apps_registered', {
    apps: currentIds,
    app_properties: current,
    count: current.length,
  });
  await chrome.storage.local.set({ [APPS_REGISTERED_KEY]: current });
}

export async function trackUserscriptInjected(appId: string): Promise<void> {
  await posthog.capture('userscript_injected', appEventProperties(appId));
}

export async function trackUiPageOpened(appId: string): Promise<void> {
  await posthog.capture('ui_page_opened', appEventProperties(appId));
}

export async function trackDashboardOpened(
  page: DashboardPage,
): Promise<void> {
  await posthog.capture('dashboard_opened', { page });
}

export async function trackSidepanelOpened(): Promise<void> {
  await posthog.capture('sidepanel_opened');
}

/**
 * Fire when a sign-in establishes (or switches to) a server-issued session.
 * Deduped on the resolved userId so silent token refreshes — which rewrite the
 * session with the same userId on every service-worker wake — don't re-fire;
 * a genuinely new sign-in (or a different account) does. Also $identifies so
 * the person's `os`/email land before the funnel reads them.
 */
export async function trackLoggedIn(userId: string): Promise<void> {
  if (!userId) return;
  const stored = await chrome.storage.local.get(LOGIN_TRACKED_UID_KEY);
  if (stored[LOGIN_TRACKED_UID_KEY] === userId) return;
  await posthog.identify();
  await posthog.capture('user_logged_in');
  await chrome.storage.local.set({ [LOGIN_TRACKED_UID_KEY]: userId });
}

/**
 * Fire once, the first time the native host connects on this profile. Carries
 * `os` as an event property (not just the person trait) so the install-per-OS
 * split is queryable directly off the event. Deduped via storage so a daemon
 * restart / reconnect doesn't re-fire.
 */
export async function trackHostInstalled(): Promise<void> {
  const stored = await chrome.storage.local.get(HOST_INSTALLED_FLAG_KEY);
  if (stored[HOST_INSTALLED_FLAG_KEY]) return;
  await posthog.capture('host_installed', { os: await posthog.getOS() });
  await chrome.storage.local.set({ [HOST_INSTALLED_FLAG_KEY]: Date.now() });
}

/** A user-initiated message sent to the agent (one per turn the user starts). */
export async function trackAgentMessageSent(): Promise<void> {
  await posthog.capture('agent_message_sent');
}

/**
 * An agent turn finished. `stopReason` is the daemon's turn_done reason;
 * `is_error` flags the failure reasons ('error', 'max_iterations') so the
 * non-error-response metric is `agent_response_received` filtered to
 * is_error = false.
 *
 * `errorStatus`/`errorCode` (present only on stopReason==='error') carry the
 * gateway HTTP status and a coarse failure code. This is the ONLY signal for
 * failures the cloud never sees — when the daemon can't reach the gateway at
 * all (status 0, code 'network'); cloud-returned 4xx/5xx are also captured
 * server-side (api_request event).
 */
export async function trackAgentResponseReceived(
  stopReason: string,
  errorStatus?: number,
  errorCode?: string,
): Promise<void> {
  const isError = stopReason === 'error' || stopReason === 'max_iterations';
  await posthog.capture('agent_response_received', {
    stop_reason: stopReason,
    is_error: isError,
    ...(typeof errorStatus === 'number' ? { error_status: errorStatus } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
  });
}
