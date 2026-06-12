import { createClient } from '@supabase/supabase-js';

export const USER_EMAIL_KEY = '__airglow_user_email';
export const AIRGLOW_USER_ID_KEY = '__airglow_user_id';
export const AIRGLOW_SESSION_TOKEN_KEY = '__airglow_session_token';
export const AIRGLOW_REFRESH_TOKEN_KEY = '__airglow_refresh_token';
export const AIRGLOW_AUTH_PROVIDER_KEY = '__airglow_auth_provider';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_CLOUD_APP_SOURCE_URL = 'https://mvp-api.airglow.dev';
const CLOUD_APP_SOURCE_URL = import.meta.env.WXT_CLOUD_APP_SOURCE_URL
  || import.meta.env.WXT_OFFICIAL_APP_SOURCE_URL
  || DEFAULT_CLOUD_APP_SOURCE_URL;

export function normalizeUserEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : undefined;
}

export async function sha256Email(value: unknown): Promise<string | undefined> {
  const email = normalizeUserEmail(value);
  if (!email) return undefined;
  const bytes = new TextEncoder().encode(email);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidUserEmail(value: unknown): boolean {
  return normalizeUserEmail(value) !== undefined;
}

export async function getAirglowIdentity(): Promise<{ email?: string; userId: string }> {
  const stored = await chrome.storage.local.get([USER_EMAIL_KEY, AIRGLOW_USER_ID_KEY]);
  let userId = typeof stored[AIRGLOW_USER_ID_KEY] === 'string' ? stored[AIRGLOW_USER_ID_KEY] : '';
  if (!userId) {
    userId = `ag_${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [AIRGLOW_USER_ID_KEY]: userId });
  }
  return {
    email: normalizeUserEmail(stored[USER_EMAIL_KEY]),
    userId,
  };
}

export type AirglowIdentityHeaders = {
  'X-Airglow-User-Id': string;
  'X-Airglow-User-Email'?: string;
  Authorization?: string;
};

export type AirglowIdentityHeadersOptions = {
  requireSession?: boolean;
};

export type AirglowAuthState = {
  authenticated: boolean;
  userId?: string;
  email?: string;
  provider?: string;
};

type PublicRuntimeConfig = {
  identity?: {
    googleOAuthEnabled?: boolean;
    supabaseUrl?: string;
    supabasePublishableKey?: string;
  };
};

export function buildIdentityHeaders(identity: { email?: string; userId: string; token?: string }): AirglowIdentityHeaders {
  return {
    'X-Airglow-User-Id': identity.userId,
    ...(identity.email ? { 'X-Airglow-User-Email': identity.email } : {}),
    ...(identity.token ? { Authorization: `Bearer ${identity.token}` } : {}),
  };
}

function cloudAppSourceUrl(): string {
  return CLOUD_APP_SOURCE_URL.replace(/\/+$/, '');
}

async function fetchPublicRuntimeConfig(): Promise<PublicRuntimeConfig> {
  const res = await fetch(`${cloudAppSourceUrl()}/api/config`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Airglow Cloud config failed with HTTP ${res.status}`);
  const json = await res.json();
  return json && typeof json === 'object' ? json as PublicRuntimeConfig : {};
}

export async function getStoredAirglowAuthState(): Promise<AirglowAuthState> {
  const stored = await chrome.storage.local.get([
    AIRGLOW_USER_ID_KEY,
    USER_EMAIL_KEY,
    AIRGLOW_SESSION_TOKEN_KEY,
    AIRGLOW_AUTH_PROVIDER_KEY,
  ]);
  const userId = typeof stored[AIRGLOW_USER_ID_KEY] === 'string' ? stored[AIRGLOW_USER_ID_KEY] : '';
  const email = normalizeUserEmail(stored[USER_EMAIL_KEY]);
  const provider = typeof stored[AIRGLOW_AUTH_PROVIDER_KEY] === 'string' ? stored[AIRGLOW_AUTH_PROVIDER_KEY] : '';
  const token = typeof stored[AIRGLOW_SESSION_TOKEN_KEY] === 'string' ? stored[AIRGLOW_SESSION_TOKEN_KEY] : '';
  return {
    authenticated: Boolean(token && userId.startsWith('supabase:') && provider === 'google'),
    ...(userId ? { userId } : {}),
    ...(email ? { email } : {}),
    ...(provider ? { provider } : {}),
  };
}

type AirglowIdentitySessionError = Error & {
  code?: string;
  status?: number;
  requestId?: string;
};

function parseIdentityError(text: string): { message: string; code?: string; requestId?: string } {
  try {
    const json = JSON.parse(text);
    const nested = json && typeof json === 'object' && typeof json.error === 'object'
      ? json.error as Record<string, unknown>
      : undefined;
    return {
      message:
        (nested && typeof nested.message === 'string' ? nested.message : undefined) ||
        (json && typeof json.message === 'string' ? json.message : undefined) ||
        text.slice(0, 500) ||
        'Airglow identity session failed',
      ...(nested && typeof nested.code === 'string' ? { code: nested.code } : {}),
      ...(nested && typeof nested.requestId === 'string' ? { requestId: nested.requestId } : {}),
    };
  } catch {
    return {
      message: text.slice(0, 500) || 'Airglow identity session failed',
    };
  }
}

async function fetchIdentitySession(
  accessToken?: string,
  refreshToken?: string,
): Promise<{ accessToken?: string; refreshToken?: string; userId?: string; userEmail?: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${cloudAppSourceUrl()}/api/identity/session`, {
    method: 'POST',
    headers,
    body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) {
    const parsed = parseIdentityError(text);
    const error = new Error(parsed.message) as AirglowIdentitySessionError;
    error.code = parsed.code || 'AIRGLOW_IDENTITY_SESSION_FAILED';
    error.status = res.status;
    error.requestId = parsed.requestId || res.headers.get('x-request-id') || undefined;
    throw error;
  }
  const json = text ? JSON.parse(text) : null;
  if (!json || typeof json !== 'object') throw new Error('Airglow identity session response was not an object');
  return json as { accessToken?: string; refreshToken?: string; userId?: string; userEmail?: string };
}

function oauthParamsFromRedirectUrl(redirectUrl: string): URLSearchParams {
  const url = new URL(redirectUrl);
  const params = new URLSearchParams(url.search);
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  if (hash) {
    const hashParams = new URLSearchParams(hash);
    for (const [key, value] of hashParams.entries()) {
      if (!params.has(key)) params.set(key, value);
    }
  }
  return params;
}

function launchWebAuthFlow(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
      const message = chrome.runtime.lastError?.message;
      if (message) {
        reject(new Error(message));
        return;
      }
      if (!redirectUrl) {
        reject(new Error('Google sign-in did not return a redirect URL'));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

function createSupabaseAuthClient(supabaseUrl: string, publishableKey: string) {
  return createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'pkce',
      persistSession: false,
    },
  });
}

export async function signInAirglowWithGoogle(): Promise<AirglowAuthState> {
  const config = await fetchPublicRuntimeConfig();
  const identity = config.identity || {};
  const supabaseUrl = String(identity.supabaseUrl || '').replace(/\/+$/, '');
  const publishableKey = String(identity.supabasePublishableKey || '').trim();
  if (!identity.googleOAuthEnabled || !supabaseUrl || !publishableKey) {
    throw new Error('Google sign-in is not configured for this Airglow Cloud server.');
  }

  const redirectTo = chrome.identity.getRedirectURL('airglow-auth');
  const supabase = createSupabaseAuthClient(supabaseUrl, publishableKey);
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      scopes: 'email profile',
      skipBrowserRedirect: true,
    },
  });
  if (error) throw error;
  if (!data?.url) throw new Error('Google sign-in did not return an authorization URL.');

  const redirectUrl = await launchWebAuthFlow(data.url);
  const params = oauthParamsFromRedirectUrl(redirectUrl);
  const oauthError = params.get('error_description') || params.get('error');
  if (oauthError) throw new Error(oauthError);

  let accessToken = params.get('access_token') || '';
  let refreshToken = params.get('refresh_token') || '';
  const authCode = params.get('code') || '';
  if (authCode) {
    const exchanged = await supabase.auth.exchangeCodeForSession(authCode);
    if (exchanged.error) throw exchanged.error;
    accessToken = exchanged.data.session?.access_token || '';
    refreshToken = exchanged.data.session?.refresh_token || '';
  }
  if (!accessToken) throw new Error('Google sign-in did not return an access token.');

  const session = await fetchIdentitySession(accessToken, refreshToken || undefined);
  const token = session.accessToken || accessToken;
  const nextRefreshToken = session.refreshToken || refreshToken;
  const userId = typeof session.userId === 'string' && session.userId ? session.userId : '';
  const email = normalizeUserEmail(session.userEmail);
  if (!userId) throw new Error('Google sign-in did not return an Airglow user id.');

  const updates: Record<string, string> = {
    [AIRGLOW_SESSION_TOKEN_KEY]: token,
    [AIRGLOW_USER_ID_KEY]: userId,
    [AIRGLOW_AUTH_PROVIDER_KEY]: 'google',
  };
  if (nextRefreshToken) updates[AIRGLOW_REFRESH_TOKEN_KEY] = nextRefreshToken;
  if (email) updates[USER_EMAIL_KEY] = email;
  await chrome.storage.local.set(updates);
  const removals: string[] = [];
  if (!nextRefreshToken) removals.push(AIRGLOW_REFRESH_TOKEN_KEY);
  if (!email) removals.push(USER_EMAIL_KEY);
  if (removals.length > 0) await chrome.storage.local.remove(removals);

  return {
    authenticated: true,
    userId,
    ...(email ? { email } : {}),
    provider: 'google',
  };
}

export async function signOutAirglowIdentity(): Promise<AirglowAuthState> {
  await chrome.storage.local.remove([
    AIRGLOW_SESSION_TOKEN_KEY,
    AIRGLOW_REFRESH_TOKEN_KEY,
    AIRGLOW_AUTH_PROVIDER_KEY,
    USER_EMAIL_KEY,
    AIRGLOW_USER_ID_KEY,
  ]);
  return { authenticated: false };
}

export async function getAirglowIdentityHeaders(options: AirglowIdentityHeadersOptions = {}): Promise<AirglowIdentityHeaders> {
  const identity = await getAirglowIdentity();
  const stored = await chrome.storage.local.get([AIRGLOW_SESSION_TOKEN_KEY, AIRGLOW_REFRESH_TOKEN_KEY]);
  const existingToken = typeof stored[AIRGLOW_SESSION_TOKEN_KEY] === 'string' ? stored[AIRGLOW_SESSION_TOKEN_KEY] : '';
  const existingRefreshToken = typeof stored[AIRGLOW_REFRESH_TOKEN_KEY] === 'string' ? stored[AIRGLOW_REFRESH_TOKEN_KEY] : '';
  try {
    const session = await fetchIdentitySession(existingToken || undefined, existingRefreshToken || undefined);
    const token = session.accessToken || existingToken;
    const refreshToken = session.refreshToken || existingRefreshToken;
    const userId = typeof session.userId === 'string' && session.userId ? session.userId : identity.userId;
    const email = normalizeUserEmail(session.userEmail) || identity.email;
    const updates: Record<string, string> = {};
    if (token && token !== existingToken) updates[AIRGLOW_SESSION_TOKEN_KEY] = token;
    if (refreshToken && refreshToken !== existingRefreshToken) updates[AIRGLOW_REFRESH_TOKEN_KEY] = refreshToken;
    if (userId && userId !== identity.userId) updates[AIRGLOW_USER_ID_KEY] = userId;
    if (email && email !== identity.email) updates[USER_EMAIL_KEY] = email;
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
    return buildIdentityHeaders({ userId, email, token });
  } catch (error) {
    if (options.requireSession) throw error;
    return buildIdentityHeaders(identity);
  }
}
