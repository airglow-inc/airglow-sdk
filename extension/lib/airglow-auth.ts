// Google sign-in → Airglow session.
//
// Credential acquisition, in preference order:
//   1. chrome.identity.getAuthToken — Chrome only, uses the browser profile's
//      Google account. Silent after the first consent click.
//   2. chrome.identity.launchWebAuthFlow — Brave/Edge/signed-out Chrome.
//      Standard Google popup returning an ID token to the fixed
//      https://<extension-id>.chromiumapp.org/ redirect.
// Either credential is exchanged at POST /api/auth/google for a session JWT;
// the server resolves both to the same Google account, so the resulting
// userId (`gaia_<sub>`) is identical across browsers — and will match the
// website login later.
//
// The session is stored in chrome.storage.local; airglow-identity reads it
// (by key, no import — avoids a module cycle) so userId/email flow to
// telemetry and identity headers automatically.

import { logger } from './logger';
import { getCloudApiUrl } from './cloud-api';

export const AUTH_SESSION_KEY = '__airglow_auth_session';

// OAuth client ids — public identifiers, not secrets (env vars only exist to
// point a fork at its own Google project). EXT is bound to the Web Store
// extension id, so on local builds (different id) getAuthToken fails and the
// web flow below takes over — its redirect URI is registered for both ids.
const EXT_CLIENT_ID = (import.meta.env.WXT_GOOGLE_EXT_CLIENT_ID as string | undefined)
  || '290831017812-6833j8lm6kuc3u75v6jvcnba7hmobsls.apps.googleusercontent.com';
const WEB_CLIENT_ID = (import.meta.env.WXT_GOOGLE_WEB_CLIENT_ID as string | undefined)
  || '290831017812-fblsiun7fl9nohb79v8567d3ljcmn645.apps.googleusercontent.com';
const OAUTH_SCOPES = ['openid', 'email', 'profile'];

// Refresh when under 7 of the 30 days remain — any gateway call before then
// keeps working without a popup.
const REFRESH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

export type AuthSession = {
  token: string;
  userId: string;
  email?: string;
  expiresAt: number;
};

export function isAuthConfigured(): boolean {
  return Boolean(EXT_CLIENT_ID || WEB_CLIENT_ID);
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

async function exchangeAtBackend(credential: { accessToken?: string; idToken?: string }): Promise<AuthSession> {
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

// --- Chrome profile path (getAuthToken) --------------------------------------

async function chromeAccessToken(interactive: boolean): Promise<string | null> {
  if (!EXT_CLIENT_ID || !chrome.identity?.getAuthToken) return null;
  try {
    const result = await chrome.identity.getAuthToken({ interactive });
    const token = typeof result === 'string' ? result : result?.token;
    return token || null;
  } catch (e) {
    logger.info('airglow', `getAuthToken unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function dropCachedAccessToken(token: string): Promise<void> {
  try {
    await chrome.identity.removeCachedAuthToken({ token });
  } catch {
    /* cache miss is fine */
  }
}

// --- Web auth flow path (launchWebAuthFlow) ----------------------------------

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function webFlowIdToken(interactive: boolean): Promise<string | null> {
  if (!WEB_CLIENT_ID || !chrome.identity?.launchWebAuthFlow) return null;
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: WEB_CLIENT_ID,
    response_type: 'id_token',
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES.join(' '),
    nonce: randomNonce(),
    ...(interactive ? { prompt: 'select_account' } : { prompt: 'none' }),
  });
  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      interactive,
    });
    if (!responseUrl) return null;
    const fragment = new URL(responseUrl).hash.replace(/^#/, '');
    return new URLSearchParams(fragment).get('id_token');
  } catch (e) {
    logger.info('airglow', `launchWebAuthFlow failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// --- Public API ---------------------------------------------------------------

export async function signInWithGoogle(opts: { interactive: boolean }): Promise<AuthSession> {
  if (!isAuthConfigured()) {
    throw new Error('Sign-in is not configured in this build (missing WXT_GOOGLE_*_CLIENT_ID)');
  }

  const accessToken = await chromeAccessToken(opts.interactive);
  if (accessToken) {
    try {
      const session = await exchangeAtBackend({ accessToken });
      await persistSession(session);
      return session;
    } catch (e) {
      // A cached-but-revoked Chrome token 401s at the backend; drop it and
      // retry once with a fresh one before falling through to the web flow.
      if ((e as { status?: number }).status === 401) {
        await dropCachedAccessToken(accessToken);
        const fresh = await chromeAccessToken(opts.interactive);
        if (fresh && fresh !== accessToken) {
          const session = await exchangeAtBackend({ accessToken: fresh });
          await persistSession(session);
          return session;
        }
      }
      if ((e as { status?: number }).status === undefined) throw e; // network/server unreachable
    }
  }

  const idToken = await webFlowIdToken(opts.interactive);
  if (idToken) {
    const session = await exchangeAtBackend({ idToken });
    await persistSession(session);
    return session;
  }

  throw new Error(opts.interactive
    ? 'Google sign-in was cancelled or unavailable'
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
  try {
    await chrome.identity.clearAllCachedAuthTokens?.();
  } catch {
    /* non-Chrome */
  }
}
