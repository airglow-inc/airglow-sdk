// Google sign-in → Airglow session.
//
// One credential path: chrome.identity.launchWebAuthFlow — a standard Google
// OAuth popup returning an id_token to the fixed
// https://<extension-id>.chromiumapp.org/ redirect. A single "Web
// application"-type OAuth client drives this on every Chromium browser
// (Chrome/Brave/Edge) and on both the Web Store and local extension ids (it
// registers a redirect URI for each).
//
// The id_token is exchanged at POST /api/auth/google for a session JWT; the
// resulting userId (`gaia_<sub>`) is the Google account itself, so it matches
// the website login later.
//
// The session is stored in chrome.storage.local; airglow-identity reads it
// (by key, no import — avoids a module cycle) so userId/email flow to
// telemetry and identity headers automatically.

import { logger } from './logger';
import { getCloudApiUrl } from './cloud-api';

export const AUTH_SESSION_KEY = '__airglow_auth_session';

// OAuth web client id — a public identifier, not a secret (the env var only
// exists so a fork can point at its own Google project). Its authorized
// redirect URIs include `https://<id>.chromiumapp.org/` for both the Web Store
// and local extension ids.
const WEB_CLIENT_ID = (import.meta.env.WXT_GOOGLE_WEB_CLIENT_ID as string | undefined)
  || '290831017812-fblsiun7fl9nohb79v8567d3ljcmn645.apps.googleusercontent.com';
const OAUTH_SCOPES = ['openid', 'email', 'profile'];

// Refresh when under 15 of the 30 days remain — any service-worker boot in the
// token's second half silently rolls it over, so a user who opens the browser
// at least once a fortnight never sees a re-sign-in.
const REFRESH_MARGIN_MS = 15 * 24 * 60 * 60 * 1000;

export type AuthSession = {
  token: string;
  userId: string;
  email?: string;
  expiresAt: number;
};

// Thrown when the user actively dismisses the interactive account picker /
// consent window. Callers treat it as a no-op (no error UI) rather than a
// failure.
export class AuthCancelledError extends Error {
  constructor(message = 'Sign-in cancelled') {
    super(message);
    this.name = 'AuthCancelledError';
  }
}

export function isAuthConfigured(): boolean {
  return Boolean(WEB_CLIENT_ID);
}

function parseSession(value: unknown): AuthSession | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (typeof s.token !== 'string' || typeof s.userId !== 'string' || typeof s.expiresAt !== 'number') return null;
  if (s.expiresAt <= Date.now()) return null;
  return {
    token: s.token,
    userId: s.userId,
    email: typeof s.email === 'string' ? s.email : undefined,
    expiresAt: s.expiresAt,
  };
}

export async function getStoredSession(): Promise<AuthSession | null> {
  const stored = await chrome.storage.local.get(AUTH_SESSION_KEY);
  return parseSession(stored[AUTH_SESSION_KEY]);
}

async function exchangeAtBackend(credential: { idToken: string }): Promise<AuthSession> {
  const res = await fetch(`${await getCloudApiUrl()}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credential),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message || `sign-in failed (${res.status})`;
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  const session: AuthSession = {
    token: body.token,
    userId: body.userId,
    email: typeof body.email === 'string' ? body.email : undefined,
    expiresAt: body.expiresAt,
  };
  if (!session.token || !session.userId) throw new Error('sign-in failed: malformed server response');
  return session;
}

async function persistSession(session: AuthSession): Promise<void> {
  // Mirror into the legacy identity keys so ensureIdentity, PostHog, and the
  // daemon all converge on the server-issued identity.
  const patch: Record<string, unknown> = {
    [AUTH_SESSION_KEY]: session,
    ['__airglow_user_id']: session.userId,
  };
  if (session.email) patch['__airglow_user_email'] = session.email;
  await chrome.storage.local.set(patch);
}

// --- Web auth flow (launchWebAuthFlow) ----------------------------------------

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The account the user last signed in with — mirrored into __airglow_user_email
// and NOT cleared when the session token is dropped, so a re-sign-in can
// pre-select it (the user needn't remember which Google account they used).
async function lastKnownEmail(): Promise<string | undefined> {
  try {
    const r = await chrome.storage.local.get(['__airglow_user_email']);
    const e = r['__airglow_user_email'];
    return typeof e === 'string' && e.includes('@') ? e : undefined;
  } catch {
    return undefined;
  }
}

// Returns the id_token, or null when sign-in is unavailable (silent prompt:none
// couldn't resolve a session, or launchWebAuthFlow is missing). Throws
// AuthCancelledError when the user dismisses the interactive window.
async function webFlowIdToken(interactive: boolean): Promise<string | null> {
  if (!WEB_CLIENT_ID || !chrome.identity?.launchWebAuthFlow) return null;
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: WEB_CLIENT_ID,
    response_type: 'id_token',
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES.join(' '),
    nonce: randomNonce(),
  });
  // Pre-select the previously-used account so a re-sign-in doesn't make the
  // user guess which email they used. With a hint we skip the forced
  // account-chooser (Google still lets them switch via "use another account");
  // with no hint (first-ever sign-in) we show the chooser.
  const hint = await lastKnownEmail();
  if (!interactive) {
    params.set('prompt', 'none');
    if (hint) params.set('login_hint', hint);
  } else if (hint) {
    params.set('login_hint', hint);
  } else {
    params.set('prompt', 'select_account');
  }
  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      interactive,
    });
    if (!responseUrl) return null;
    const fragment = new URL(responseUrl).hash.replace(/^#/, '');
    return new URLSearchParams(fragment).get('id_token');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Closing the picker rejects the promise — surface that as a cancel (no
    // error UI) rather than a failure. Silent (prompt:none) rejections are
    // expected "no resolvable session" → null.
    if (interactive && /did not approve|cancell?ed|user (denied|rejected|closed)|window.*closed|closed.*window/i.test(msg)) {
      throw new AuthCancelledError(msg);
    }
    logger.info('airglow', `launchWebAuthFlow failed: ${msg}`);
    return null;
  }
}

// --- Public API ---------------------------------------------------------------

export async function signInWithGoogle(opts: { interactive: boolean }): Promise<AuthSession> {
  if (!isAuthConfigured()) {
    throw new Error('Sign-in is not configured in this build (missing WXT_GOOGLE_WEB_CLIENT_ID)');
  }

  const idToken = await webFlowIdToken(opts.interactive);
  if (idToken) {
    const session = await exchangeAtBackend({ idToken });
    await persistSession(session);
    return session;
  }

  throw new Error(opts.interactive
    ? 'Google sign-in was unavailable'
    : 'silent sign-in unavailable');
}

// Returns a valid session, silently refreshing or establishing one when
// possible. Never interactive; returns null when sign-in needs a user click.
export async function ensureSession(): Promise<AuthSession | null> {
  const stored = await getStoredSession();
  if (stored && stored.expiresAt - Date.now() > REFRESH_MARGIN_MS) return stored;
  try {
    return await signInWithGoogle({ interactive: false });
  } catch {
    return stored; // valid but nearing expiry beats nothing
  }
}

export async function signOut(): Promise<void> {
  await chrome.storage.local.remove(AUTH_SESSION_KEY);
}
