export const USER_EMAIL_KEY = '__airglow_user_email';
export const EMAIL_REQUIRED_CODE = 'EMAIL_REQUIRED';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_EXEMPT_MESSAGE_TYPES = new Set([
  'airglow:identity:getUserEmail',
  'airglow:identity:setUserEmail',
  'airglow:log',
]);

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

export function requiresUserEmail(messageType: unknown): boolean {
  if (typeof messageType !== 'string') return false;
  return !EMAIL_EXEMPT_MESSAGE_TYPES.has(messageType);
}

export function buildEmailRequiredResponse(onboardingUrl?: string) {
  return {
    error: 'Airglow needs your email before apps can run.',
    code: EMAIL_REQUIRED_CODE,
    onboardingUrl,
  };
}
