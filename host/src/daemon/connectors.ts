// Connector service — DIRECT mode of the native Composio integration: the
// developer escape hatch used when the workspace .env carries its own
// COMPOSIO_API_KEY (a personal dev project). Production machines have no key;
// the daemon then forwards /api/connectors/* verbatim to the cloud gateway
// (airglow-cloud lib/connectors.ts + app/api/connectors/), which holds the
// single shared project key and mints the user scope from the verified
// session — see the gateway-mode branch in daemon/index.ts.
//
// Identity model (kept format-compatible with the gateway): Composio
// user_id = `airglow.<airglowUserId>.<appId>.<account>`, with the literal
// user segment `local` in this direct mode. The account label scopes one
// external identity (e.g. a Google account) and defaults to "default".
// Scoping by appId means connections are per-app — each app shows its own
// OAuth consent moment; one app can never silently use credentials another
// app obtained. The agent uses the pseudo-app id "agent".
//
// The label is a claim, not a verified identity: login_hint nudges Google to
// preselect the matching account, but the user can authorize a different one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3.1';
const USER_ID_PREFIX = 'airglow.';
const LOCAL_USER_SEGMENT = 'local';
export const DEFAULT_ACCOUNT = 'default';
export const AGENT_APP_ID = 'agent';

// Where gateway-mode connector calls go. Independent of agent/api.ts
// gatewayUrl(), which returns null in ANTHROPIC_API_KEY dev mode — an LLM
// concern that must not flip the connector transport.
export function connectorGatewayUrl(): string {
  return (process.env.AIRGLOW_GATEWAY_URL || 'https://api.airglow.dev').replace(/\/+$/, '');
}

export interface ConnectorError extends Error {
  code: string;
  status?: number;
}

function connectorError(message: string, code: string, status?: number): ConnectorError {
  const e = new Error(message) as ConnectorError;
  e.code = code;
  e.status = status;
  return e;
}

export interface ConnectedAccountInfo {
  id: string;
  appId: string;
  account: string;
  toolkit: string;
  status: string;
  createdAt?: string;
}

export class ConnectorService {
  // toolkit slug → auth config id. Auth configs are per-project blueprints;
  // one managed config per toolkit, created lazily.
  private authConfigCache = new Map<string, string>();

  constructor(readonly workspace: string) {}

  // Read fresh per call (same policy as RPC env loading) so a key added to
  // the workspace .env works without a daemon restart.
  private apiKey(): string | null {
    try {
      for (const line of readFileSync(join(this.workspace, '.env'), 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        if (trimmed.slice(0, eq).trim() === 'COMPOSIO_API_KEY') {
          return trimmed.slice(eq + 1).trim() || null;
        }
      }
    } catch {}
    return process.env.COMPOSIO_API_KEY || null;
  }

  hasApiKey(): boolean {
    return this.apiKey() !== null;
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const key = this.apiKey();
    if (!key) {
      throw connectorError(
        'COMPOSIO_API_KEY is not set. Add it to the workspace .env (get a key at https://app.composio.dev).',
        'CONNECTOR_NO_API_KEY',
      );
    }
    const res = await fetch(`${COMPOSIO_BASE}${path}`, {
      method,
      headers: {
        'x-api-key': key,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(55_000),
    });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const message = data?.error?.message || data?.message || data?.error || `Composio API ${res.status}`;
      throw connectorError(String(message), 'CONNECTOR_UPSTREAM_ERROR', res.status);
    }
    return data;
  }

  // ── Identity ──

  userId(appId: string, account: string): string {
    return `${USER_ID_PREFIX}${LOCAL_USER_SEGMENT}.${appId}.${account || DEFAULT_ACCOUNT}`;
  }

  // User segment and appId never contain '.'; the account label is the
  // remainder after the second dot (emails contain dots).
  private parseUserId(userId: string): { appId: string; account: string } | null {
    if (!userId.startsWith(USER_ID_PREFIX)) return null;
    const rest = userId.slice(USER_ID_PREFIX.length);
    const d1 = rest.indexOf('.');
    if (d1 <= 0) return null;
    const d2 = rest.indexOf('.', d1 + 1);
    if (d2 <= d1 + 1) return null;
    if (rest.slice(0, d1) !== LOCAL_USER_SEGMENT) return null;
    return { appId: rest.slice(d1 + 1, d2), account: rest.slice(d2 + 1) };
  }

  // ── Auth configs ──

  private async getOrCreateAuthConfig(toolkit: string): Promise<string> {
    const cached = this.authConfigCache.get(toolkit);
    if (cached) return cached;
    const list = await this.req('GET', `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&limit=50`);
    const items: any[] = list?.items ?? [];
    const existing = items.find((c) => (c?.toolkit?.slug ?? c?.toolkit) === toolkit) ?? items[0];
    if (existing?.id) {
      this.authConfigCache.set(toolkit, existing.id);
      return existing.id;
    }
    const created = await this.req('POST', '/auth_configs', {
      toolkit: { slug: toolkit },
      auth_config: { type: 'use_composio_managed_auth', name: `Airglow ${toolkit}` },
    });
    const id = created?.auth_config?.id ?? created?.id;
    if (!id) throw connectorError(`auth config creation for ${toolkit} returned no id`, 'CONNECTOR_UPSTREAM_ERROR');
    this.authConfigCache.set(toolkit, id);
    return id;
  }

  // ── Connections ──

  private async listFor(userId: string, toolkit: string): Promise<any[]> {
    const data = await this.req(
      'GET',
      `/connected_accounts?user_ids=${encodeURIComponent(userId)}&toolkit_slugs=${encodeURIComponent(toolkit)}&limit=50`,
    );
    return data?.items ?? [];
  }

  async status(appId: string, toolkit: string, account: string): Promise<{ connected: boolean }> {
    const items = await this.listFor(this.userId(appId, account), toolkit);
    return { connected: items.some((a) => a.status === 'ACTIVE') };
  }

  // Returns {connected:true} if already ACTIVE, else an OAuth URL to open.
  // Stale non-ACTIVE records for the same (user, toolkit) are deleted first
  // so abandoned attempts don't accumulate.
  async initiate(
    appId: string,
    toolkit: string,
    account: string,
  ): Promise<{ connected: true } | { connected: false; authUrl: string; connectedAccountId: string }> {
    const userId = this.userId(appId, account);
    const existing = await this.listFor(userId, toolkit);
    if (existing.some((a) => a.status === 'ACTIVE')) return { connected: true };
    for (const stale of existing) {
      await this.req('DELETE', `/connected_accounts/${stale.id}`).catch(() => {});
    }
    const authConfigId = await this.getOrCreateAuthConfig(toolkit);
    const link = await this.req('POST', '/connected_accounts/link', {
      auth_config_id: authConfigId,
      user_id: userId,
    });
    if (!link?.redirect_url || !link?.connected_account_id) {
      throw connectorError(`connection link for ${toolkit} returned no redirect URL`, 'CONNECTOR_UPSTREAM_ERROR');
    }
    let authUrl: string = link.redirect_url;
    if (account.includes('@')) authUrl = await rewriteWithLoginHint(authUrl, account);
    return { connected: false, authUrl, connectedAccountId: link.connected_account_id };
  }

  // Poll one pending connection until ACTIVE, a terminal status, or timeout.
  // Callers (extension popup flow, CLI --wait) loop on this with short windows.
  async wait(connectedAccountId: string, timeoutMs: number): Promise<{ connected: boolean; status: string }> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 30_000);
    while (true) {
      const acc = await this.req('GET', `/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
      const status: string = acc?.status ?? 'UNKNOWN';
      if (status === 'ACTIVE') return { connected: true, status };
      if (status === 'FAILED' || status === 'EXPIRED' || status === 'REVOKED') return { connected: false, status };
      if (Date.now() >= deadline) return { connected: false, status };
      await Bun.sleep(1000);
    }
  }

  async disconnect(appId: string, toolkit: string, account: string): Promise<{ ok: true; removed: number }> {
    const items = await this.listFor(this.userId(appId, account), toolkit);
    for (const a of items) {
      await this.req('DELETE', `/connected_accounts/${a.id}`).catch(() => {});
    }
    return { ok: true, removed: items.length };
  }

  async deleteAccount(connectedAccountId: string): Promise<{ ok: true }> {
    await this.req('DELETE', `/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
    return { ok: true };
  }

  // All airglow-scheme connections in the Composio project, for the dashboard.
  async listAccounts(): Promise<ConnectedAccountInfo[]> {
    const out: ConnectedAccountInfo[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data = await this.req(
        'GET',
        `/connected_accounts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      for (const item of data?.items ?? []) {
        const parsed = this.parseUserId(String(item?.user_id ?? ''));
        if (!parsed) continue;
        out.push({
          id: item.id,
          appId: parsed.appId,
          account: parsed.account,
          toolkit: item?.toolkit?.slug ?? '',
          status: item?.status ?? 'UNKNOWN',
          createdAt: item?.created_at,
        });
      }
      cursor = data?.next_cursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  // ── Execution ──

  async execute(
    appId: string,
    toolSlug: string,
    args: Record<string, unknown>,
    account: string,
  ): Promise<{ data: unknown; successful: boolean; error: string | null }> {
    const userId = this.userId(appId, account);
    const result = await this.req('POST', `/tools/execute/${encodeURIComponent(toolSlug)}`, {
      user_id: userId,
      arguments: args ?? {},
    }).catch(async (e: ConnectorError) => {
      // Distinguish "not connected" from genuine tool failures so apps can
      // route the user to connect().
      if (e.code === 'CONNECTOR_UPSTREAM_ERROR') {
        const toolkit = toolSlug.split('_')[0]?.toLowerCase();
        if (toolkit) {
          const { connected } = await this.status(appId, toolkit, account).catch(() => ({ connected: true }));
          if (!connected) {
            throw connectorError(
              `no active ${toolkit} connection for app "${appId}" (account "${account}") — call airglow.connectors.connect first`,
              'CONNECTOR_NOT_CONNECTED',
            );
          }
        }
      }
      throw e;
    });
    return {
      data: result?.data,
      successful: !!result?.successful,
      error: result?.error ?? null,
    };
  }

  // ── Discovery (CLI / agent) ──

  async searchToolkits(query: string): Promise<any[]> {
    const data = await this.req('GET', `/toolkits?search=${encodeURIComponent(query)}&limit=20`);
    return (data?.items ?? []).map((tk: any) => ({
      slug: tk.slug,
      name: tk.name,
      tools: tk?.meta?.tools_count,
      description: tk?.meta?.description,
    }));
  }

  async listTools(toolkit: string, search?: string): Promise<any[]> {
    const params = new URLSearchParams({ toolkit_slug: toolkit, limit: '1000' });
    if (search) params.set('search', search);
    const data = await this.req('GET', `/tools?${params}`);
    return (data?.items ?? []).map((t: any) => ({ slug: t.slug, name: t.name, description: t.description }));
  }

  async toolSchema(toolSlug: string): Promise<any> {
    const t = await this.req('GET', `/tools/${encodeURIComponent(toolSlug)}`);
    return {
      slug: t.slug,
      name: t.name,
      description: t.description,
      toolkit: t?.toolkit?.slug,
      input_parameters: t.input_parameters,
    };
  }
}

// Google shows an account chooser on OAuth; pre-resolving Composio's redirect
// and appending login_hint preselects the account matching the label.
async function rewriteWithLoginHint(authUrl: string, email: string): Promise<string> {
  try {
    const res = await fetch(authUrl, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const location = res.headers.get('location');
    if (location?.includes('accounts.google.com')) {
      return `${location}&login_hint=${encodeURIComponent(email)}`;
    }
  } catch {}
  return authUrl;
}
