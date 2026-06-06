export const USER_EMAIL_KEY = '__airglow_user_email';
export const AIRGLOW_USER_ID_KEY = '__airglow_user_id';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export function buildIdentityHeaders(identity: { email?: string; userId: string }): Record<string, string> {
  return {
    'X-Airglow-User-Id': identity.userId,
    ...(identity.email ? { 'X-Airglow-User-Email': identity.email } : {}),
  };
}

export async function getAirglowIdentityHeaders(): Promise<Record<string, string>> {
  return buildIdentityHeaders(await getAirglowIdentity());
}
