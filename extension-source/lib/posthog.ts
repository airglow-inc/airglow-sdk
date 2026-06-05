/**
 * PostHog client — product analytics that ingests directly from the extension
 * without going through our Next backend. Survives the backend being offline.
 *
 * Configuration via WXT-injected env (read at build time, see wxt.config.ts):
 *   WXT_POSTHOG_KEY  — phc_… project key. Empty/absent → no-op.
 *   WXT_POSTHOG_HOST — defaults to https://api.airglow.dev/e.
 *
 * MV3 service workers have no `window` and no localStorage; we force in-memory
 * persistence and re-`identify()` on every event so a suspended SW that wakes
 * with a fresh memory storage still tags events with the correct distinctId.
 *
 * Distinct ID = `__airglow_user_id` (the same anonymous extension id we send
 * as `X-Airglow-User-Id`), so PostHog persons line up with Vercel Analytics
 * `userIdHash` (which is salted SHA-256 of the same value).
 */

import { PostHog } from 'posthog-js-lite';
import { logger } from './logger';
import { USER_EMAIL_KEY, normalizeUserEmail } from './airglow-identity';

const USER_ID_KEY = '__airglow_user_id';
const DEFAULT_HOST = 'https://api.airglow.dev/e';
// Public, write-only PostHog Project API key — safe to embed in the published
// extension bundle. Override at build time with WXT_POSTHOG_KEY (e.g. point a
// dev build at a separate test project).
const DEFAULT_KEY = 'phc_nUaAkXacoSn97fwjsjuQNKvYKc3uYzgsZAq5jc7ZA4XS';

let clientCache: PostHog | null | undefined;

function readBuildEnv(key: string): string | undefined {
  // import.meta.env is populated by WXT/Vite at build time. Guarded for the
  // case where this module is imported in a non-bundled context (tests).
  const env = (import.meta as { env?: Record<string, string | number | boolean | null> }).env;
  const value = env?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function getClient(): PostHog | null {
  if (clientCache !== undefined) return clientCache;
  const key = readBuildEnv('WXT_POSTHOG_KEY') || DEFAULT_KEY;
  if (!key) {
    clientCache = null;
    return null;
  }
  const host = readBuildEnv('WXT_POSTHOG_HOST') || DEFAULT_HOST;
  try {
    clientCache = new PostHog(key, {
      host,
      // SW has no localStorage; memory is fine because distinctId is restored
      // from chrome.storage on each event via identify().
      persistence: 'memory',
      autocapture: false,
      // Don't try to pull feature flags — we're write-only.
      preloadFeatureFlags: false,
      // Disable surveys/etc. silently.
      disableSurveys: true,
      // MV3 service workers can be suspended before the default 10s batch
      // timer fires. Send each analytics event immediately instead.
      flushAt: 1,
      flushInterval: 0,
    } as ConstructorParameters<typeof PostHog>[1]);
  } catch (e) {
    logger.warn('airglow', `posthog init failed: ${e instanceof Error ? e.message : String(e)}`);
    clientCache = null;
  }
  return clientCache;
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

type PropertyValue = string | number | boolean | null | string[];

function scrubString(input: string): string {
  let s = input.replace(URL_QUERY_RE, '$1');
  s = s.replace(JWT_RE, '[token]');
  s = s.replace(EMAIL_RE, '[email]');
  if (s.length > MAX_PROP_LEN) s = s.slice(0, MAX_PROP_LEN) + '…';
  return s;
}

function sanitizeValue(v: PropertyValue): PropertyValue {
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map((s) => (typeof s === 'string' ? scrubString(s) : s));
  return v;
}

function sanitizeProperties(properties: Record<string, PropertyValue>): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const [k, v] of Object.entries(properties)) {
    out[k] = sanitizeValue(v);
  }
  return out;
}

/**
 * Send an event to PostHog. Idempotent identify() on every call so the SW
 * restart case (memory persistence cleared) doesn't drop the distinctId.
 */
export async function capture(event: string, properties: Record<string, PropertyValue> = {}): Promise<void> {
  const client = getClient();
  if (!client) return;
  const identity = await getIdentity();
  if (!identity) return;
  try {
    client.identify(identity.distinctId, identity.email ? { email: identity.email } : undefined);
    client.capture(event, sanitizeProperties(properties));
    await client.flush();
  } catch (e) {
    logger.warn('airglow', `posthog capture '${event}' failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Set/refresh person properties without emitting a `$identify`-only event.
 * Use after the user supplies their email.
 */
export async function identify(extra: Record<string, PropertyValue> = {}): Promise<void> {
  const client = getClient();
  if (!client) return;
  const identity = await getIdentity();
  if (!identity) return;
  try {
    const traits: Record<string, PropertyValue> = { ...sanitizeProperties(extra) };
    if (identity.email) traits.email = identity.email;
    client.identify(identity.distinctId, traits);
    await client.flush();
  } catch (e) {
    logger.warn('airglow', `posthog identify failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
