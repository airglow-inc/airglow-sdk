import { Composio } from '@composio/core';

let _client: InstanceType<typeof Composio> | null = null;

export function getClient(): InstanceType<typeof Composio> {
  if (!_client) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set');
    _client = new Composio({ apiKey });
  }
  return _client;
}

export function userIdForEmail(email: string): string {
  return `airglow-gmail-${email.trim().toLowerCase()}`;
}

const authConfigCache = new Map<string, string>();

// Lazily get-or-create a Composio-managed auth config per toolkit. v3 requires
// an auth_config_id for connectedAccounts.link; auto-creating means no dashboard
// trip when a new app wires up a new toolkit.
async function getOrCreateAuthConfigId(toolkitSlug: string): Promise<string> {
  const cached = authConfigCache.get(toolkitSlug);
  if (cached) return cached;
  const c = getClient();
  const list = await c.authConfigs.list({ toolkit: toolkitSlug });
  const existing = (list.items ?? []).find((cfg: any) => cfg?.toolkit?.slug === toolkitSlug || cfg?.toolkit === toolkitSlug);
  if (existing?.id) {
    authConfigCache.set(toolkitSlug, existing.id);
    return existing.id;
  }
  const created = await c.authConfigs.create(toolkitSlug.toUpperCase(), {
    type: 'use_composio_managed_auth',
    name: `Airglow ${toolkitSlug}`,
  });
  authConfigCache.set(toolkitSlug, created.id);
  return created.id;
}

// Returns Google's OAuth URL pre-populated with login_hint=email so the user
// doesn't have to pick the right Google account. Falls back to Composio's
// redirect URL on any error.
async function rewriteRedirectWithLoginHint(authUrl: string, email: string): Promise<string> {
  try {
    const res = await fetch(authUrl, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (location?.includes('accounts.google.com')) {
      return `${location}&login_hint=${encodeURIComponent(email)}`;
    }
  } catch {}
  return authUrl;
}

export async function initiateOAuth(
  userEmail: string,
  toolkitSlug: string,
): Promise<{ authUrl: string | null; connectionId: string }> {
  const c = getClient();
  const userId = userIdForEmail(userEmail);
  const authConfigId = await getOrCreateAuthConfigId(toolkitSlug);
  const req = await c.connectedAccounts.link(userId, authConfigId);
  let authUrl = req.redirectUrl ?? null;
  if (authUrl) authUrl = await rewriteRedirectWithLoginHint(authUrl, userEmail);
  return { authUrl, connectionId: req.id };
}

export async function hasActiveConnection(userEmail: string, toolkitSlug: string): Promise<boolean> {
  const c = getClient();
  const userId = userIdForEmail(userEmail);
  const accounts = await c.connectedAccounts.list({
    userIds: [userId],
    toolkitSlugs: [toolkitSlug],
  });
  return (accounts.items ?? []).some((a: any) => a.status === 'ACTIVE');
}
