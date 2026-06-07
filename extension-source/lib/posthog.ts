/**
 * PostHog client — product analytics that ingests directly from the extension
 * through Airglow's reverse proxy.
 *
 * Configuration via WXT-injected env (read at build time, see wxt.config.ts):
 *   WXT_POSTHOG_KEY  — phc_… project key. Empty/absent → no-op.
 *   WXT_POSTHOG_HOST — defaults to https://api.airglow.dev/e.
 *
 * Uses PostHog's documented public capture API:
 *   POST {host}/i/v0/e/
 * with top-level api_key, event, distinct_id, and properties.
 *
 * Distinct ID = `__airglow_user_id` (the same anonymous extension id we send
 * as `X-Airglow-User-Id`), so PostHog persons line up with Vercel Analytics
 * `userIdHash` (which is salted SHA-256 of the same value).
 */

import { logger } from './logger';
import { USER_EMAIL_KEY, normalizeUserEmail } from './airglow-identity';

const USER_ID_KEY = '__airglow_user_id';
const DEFAULT_HOST = 'https://api.airglow.dev/e';
// Public, write-only PostHog Project API key — safe to embed in the published
// extension bundle. Override at build time with WXT_POSTHOG_KEY (e.g. point a
// dev build at a separate test project).
const DEFAULT_KEY = 'phc_nUaAkXacoSn97fwjsjuQNKvYKc3uYzgsZAq5jc7ZA4XS';
const REQUEST_TIMEOUT_MS = 10_000;

type Config = { key: string; host: string };
let configCache: Config | null | undefined;

function readBuildEnv(key: string): string | undefined {
  // import.meta.env is populated by WXT/Vite at build time. Guarded for the
  // case where this module is imported in a non-bundled context (tests).
  const env = (import.meta as { env?: Record<string, string | number | boolean | null> }).env;
  const value = env?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function getConfig(): Config | null {
  if (configCache !== undefined) return configCache;
  const key = readBuildEnv('WXT_POSTHOG_KEY') || DEFAULT_KEY;
  if (!key) {
    configCache = null;
    return null;
  }
  const host = (readBuildEnv('WXT_POSTHOG_HOST') || DEFAULT_HOST).replace(/\/+$/, '');
  configCache = { key, host };
  return configCache;
}

async function getIdentity(): Promise<{ distinctId: string; email?: string } | null> {
  const stored = await chrome.storage.local.get([USER_ID_KEY, USER_EMAIL_KEY]);
  let distinctId = typeof stored[USER_ID_KEY] === 'string' ? stored[USER_ID_KEY] : '';
  if (!distinctId) {
    distinctId = `ag_${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [USER_ID_KEY]: distinctId });
  }
  return { distinctId, email: normalizeUserEmail(stored[USER_EMAIL_KEY]) };
}

const MAX_PROP_LEN = 500;
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
// Query strings on URLs are the highest-leakage source: OAuth tokens, session
// ids, authuser, reqid, gsessionid — all live there. Drop the whole `?…` tail.
const URL_QUERY_RE = /(https?:\/\/[^\s?#]+)\?[^\s]*/g;

type PropertyValue =
  | string
  | number
  | boolean
  | null
  | PropertyValue[]
  | { [key: string]: PropertyValue };

function scrubString(input: string): string {
  let s = input.replace(URL_QUERY_RE, '$1');
  s = s.replace(JWT_RE, '[token]');
  s = s.replace(EMAIL_RE, '[email]');
  if (s.length > MAX_PROP_LEN) s = s.slice(0, MAX_PROP_LEN) + '…';
  return s;
}

function sanitizeValue(v: PropertyValue): PropertyValue {
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map((item) => sanitizeValue(item));
  if (v && typeof v === 'object') {
    const out: Record<string, PropertyValue> = {};
    for (const [key, value] of Object.entries(v)) out[key] = sanitizeValue(value);
    return out;
  }
  return v;
}

function sanitizeProperties(properties: Record<string, PropertyValue>): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const [k, v] of Object.entries(properties)) {
    out[k] = sanitizeValue(v);
  }
  return out;
}

async function postEvent(payload: {
  event: string;
  distinct_id: string;
  properties?: Record<string, PropertyValue>;
}): Promise<void> {
  const config = getConfig();
  if (!config) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.key,
        event: payload.event,
        distinct_id: payload.distinct_id,
        properties: payload.properties || {},
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PostHog capture returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send an event to PostHog using the documented public capture endpoint.
 */
export async function capture(
  event: string,
  properties: Record<string, PropertyValue> = {},
): Promise<void> {
  const identity = await getIdentity();
  if (!identity) return;
  try {
    const eventProperties = sanitizeProperties(properties);
    await postEvent({
      event,
      distinct_id: identity.distinctId,
      properties: eventProperties,
    });
  } catch (e) {
    logger.warn('airglow', `posthog capture '${event}' failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/**
 * Set/refresh person properties via PostHog's documented `$identify` event.
 * Use after the user supplies their email.
 */
export async function identify(extra: Record<string, PropertyValue> = {}): Promise<void> {
  const identity = await getIdentity();
  if (!identity) return;
  try {
    const traits: Record<string, PropertyValue> = { ...sanitizeProperties(extra) };
    if (identity.email) traits.email = identity.email;
    await postEvent({
      event: '$identify',
      distinct_id: identity.distinctId,
      properties: { $set: traits },
    });
  } catch (e) {
    logger.warn('airglow', `posthog identify failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
