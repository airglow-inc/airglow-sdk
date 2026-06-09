export const USER_EMAIL_KEY = '__airglow_user_email';
export const AIRGLOW_USER_ID_KEY = '__airglow_user_id';
export const AIRGLOW_SESSION_TOKEN_KEY = '__airglow_session_token';
export const AIRGLOW_REFRESH_TOKEN_KEY = '__airglow_refresh_token';

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
