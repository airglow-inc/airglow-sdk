export const USER_ID_KEY = '__airglow_user_id';
export const USER_EMAIL_KEY = '__airglow_user_email';

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

type ChromeProfile = { id: string; email?: string };

async function readChromeProfile(): Promise<ChromeProfile | null> {
  try {
    const api = chrome.identity?.getProfileUserInfo;
    if (!api) return null;
    const info = await api({ accountStatus: 'ANY' });
    if (!info?.id) return null;
    return { id: info.id, email: normalizeUserEmail(info.email) };
  } catch {
    return null;
  }
}

// Single source of truth for user_id + email. First-run resolution, value
// then persisted forever:
//   1. Chrome signed in to Google  →  user_id = `gaia_<obfuscated-gaia-id>`,
//      email auto-filled.
//   2. Otherwise (Brave, Edge, signed-out Chrome)  →  user_id = `ag_<uuid>`,
//      email left empty (user fills the dashboard form).
//
// On later calls, if user_id is set but email is empty, we re-check the
// Chrome profile — covers the case where the user signs into Chrome after
// install.
export async function ensureIdentity(): Promise<{ userId: string; email?: string }> {
  const stored = await chrome.storage.local.get([USER_ID_KEY, USER_EMAIL_KEY]);
  let userId = typeof stored[USER_ID_KEY] === 'string' ? stored[USER_ID_KEY] : '';
  let email = normalizeUserEmail(stored[USER_EMAIL_KEY]);

  if (!userId) {
    const profile = await readChromeProfile();
    const patch: Record<string, string> = {};
    if (profile?.id) {
      userId = `gaia_${profile.id}`;
      if (profile.email && !email) {
        email = profile.email;
        patch[USER_EMAIL_KEY] = email;
      }
    } else {
      userId = `ag_${crypto.randomUUID()}`;
    }
    patch[USER_ID_KEY] = userId;
    await chrome.storage.local.set(patch);
    return { userId, email };
  }

  if (!email) {
    const profile = await readChromeProfile();
    if (profile?.email) {
      email = profile.email;
      await chrome.storage.local.set({ [USER_EMAIL_KEY]: email });
    }
  }

  return { userId, email };
}
