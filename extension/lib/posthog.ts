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
 * Distinct ID = the resolved `__airglow_user_id` from ensureIdentity:
 * `gaia_<obfuscated-gaia-id>` when Chrome is signed in to Google, otherwise
 * `ag_<uuid>`. Same value flows into `X-Airglow-User-Id`, so PostHog persons
 * line up with Vercel Analytics `userIdHash` (salted SHA-256 of the same).
 */

import { logger } from './logger';
import { ensureIdentity } from './airglow-identity';
import { fetchHostVersion } from './host-probe';

const DEFAULT_HOST = 'https://api.airglow.dev/e';
// Cap how long a capture will block waiting for the boot-time $identify to
// land. Without this, a stuck network would freeze all analytics forever.
const IDENTIFY_GATE_TIMEOUT_MS = 5000;

// `capture()` awaits this before posting, so the first event a person sees
// in PostHog already has their email property set (otherwise PostHog renders
// the row with the raw distinct_id and never backfills the display name).
// Background boot calls `releaseIdentifyGate()` after the boot $identify
// resolves; if boot never runs (e.g. content-script context), the timeout
// above takes over.
let releaseIdentifyGate: () => void = () => {};
const identifyGate = new Promise<void>((resolve) => {
  releaseIdentifyGate = resolve;
});
export function markIdentifyComplete(): void {
  releaseIdentifyGate();
}
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
  const { userId, email } = await ensureIdentity();
  return { distinctId: userId, email };
}

// Operating system, resolved once and cached. Attached to every $identify as
// the `os` person property so installs and host-install bounce can be split
// per OS in PostHog. chrome.runtime.getPlatformInfo's os is one of
// 'mac' | 'win' | 'linux' | 'cros' | 'android' | 'openbsd'.
let osCache: string | undefined;
export async function getOS(): Promise<string> {
  if (osCache !== undefined) return osCache;
  osCache = await new Promise<string>((resolve) => {
    try {
      chrome.runtime.getPlatformInfo((info) => resolve(info?.os || 'unknown'));
    } catch {
      resolve('unknown');
    }
  });
  return osCache;
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
 *
 * Blocks on the identify gate so the boot-time $identify always lands first —
 * otherwise the events panel renders early rows with the raw distinct_id and
 * never backfills the email display. The timeout is a safety net for contexts
 * where boot can't run (e.g. content script) or crashed before releasing.
 */
export async function capture(
  event: string,
  properties: Record<string, PropertyValue> = {},
): Promise<void> {
  await Promise.race([
    identifyGate,
    new Promise<void>((resolve) => setTimeout(resolve, IDENTIFY_GATE_TIMEOUT_MS)),
  ]);
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
    traits.os = await getOS();
    traits.extension_version = chrome.runtime.getManifest().version;
    const hostVersion = await fetchHostVersion();
    if (hostVersion) traits.host_version = hostVersion;
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
