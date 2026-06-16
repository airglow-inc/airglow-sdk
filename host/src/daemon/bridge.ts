// Browser bridge — tracks connected connectors (one per running Chrome) and
// routes browser commands to the extension over native messaging.
//
// Wire protocol with a connector (WebSocket):
//   connector → daemon  { t: 'register', pid, userDataDir, version }
//   connector → daemon  { t: 'ext', msg }   — a message the extension sent
//   daemon → connector  { t: 'ext', msg }   — deliver msg to the extension
//   daemon → connector  { t: 'registered', port, version }
//
// Extension-level message types are unchanged from the old trace host
// (tabs / newTab / navigate / closeTab / eval / getHtml / capture / logs /
// attach / detach + reqId-correlated replies), so the extension side keeps
// working during the migration.

import type { ServerWebSocket } from 'bun';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { SHOTS_DIR } from '../paths';

export interface ConnectorInfo {
  id: number;
  pid: number | null;
  userDataDir: string | null;
  version: string | null;
  connectedAt: number;
}

interface Connector extends ConnectorInfo {
  ws: ServerWebSocket<unknown>;
}

interface NetCaptureEntry {
  url?: string;
  method?: string;
  status?: number;
  ts: number;
  tabId?: number;
  transport?: string;
  reqBody?: string | null;
  resBody?: string | null;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
}

const CAPTURE_BUFFER_LIMIT = 2000;

const APPROVAL_TIMEOUT_MS = 120_000;

export class BrowserBridge {
  private connectors = new Map<number, Connector>();
  private nextConnectorId = 1;
  private pendingReplies = new Map<string, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextReqId = 1;
  private captures: NetCaptureEntry[] = [];
  private lastReadResult: NetCaptureEntry[] | null = null;

  // ── Debug-window approval (agent sessions only) ──
  // Commands carrying a sessionId (set by the harness via AIRGLOW_SESSION)
  // need a one-time per-session user grant before the first `open`. Commands
  // without a sessionId (a human, or a third-party agent whose own harness
  // already prompted for the bash call) pass through.
  private sessionGrants = new Set<string>();
  private pendingApprovals = new Map<string, { sessionId: string; resolve: (approved: boolean) => void }>();
  private nextApprovalId = 1;
  // Wired by the daemon to surface the request in the session's chat stream.
  onApprovalRequest: ((sessionId: string, approvalId: string) => void) | null = null;

  // sessionId → Chrome window hosting the sidepanel chat that drives the
  // session. Runtime-only (window ids don't survive a browser restart);
  // refreshed on every agent:start, so it follows the user if they continue
  // the chat from another window's sidepanel.
  private sessionWindows = new Map<string, number>();

  // sessionId → connector id of the Chrome whose sidepanel drives the session.
  // Browser commands carrying a sessionId route here, so the agent's debug
  // tabs / evals / shots land in the SAME Chrome as the chat — not whichever
  // browser connected most recently (multi-Chrome setups: a dev `pnpm chrome`
  // alongside the user's daily browser, both sharing this daemon).
  private sessionConnectors = new Map<string, number>();

  setSessionWindow(sessionId: string, windowId: number): void {
    this.sessionWindows.set(sessionId, windowId);
  }

  setSessionConnector(sessionId: string, ws: ServerWebSocket<unknown>): void {
    const id = (ws.data as any)?.connectorId;
    if (typeof id === 'number') this.sessionConnectors.set(sessionId, id);
  }

  // Returns the sessionId the approval belonged to (for the resolved event),
  // or null if the id is unknown/expired.
  resolveApproval(approvalId: string, approved: boolean): string | null {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return null;
    this.pendingApprovals.delete(approvalId);
    pending.resolve(approved);
    return pending.sessionId;
  }

  private async requireDebugWindowGrant(sessionId: string): Promise<boolean> {
    if (this.sessionGrants.has(sessionId)) return true;
    if (!this.onApprovalRequest) return false; // no chat client to ask
    const approvalId = `appr-${this.nextApprovalId++}`;
    const approved = await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(approvalId, { sessionId, resolve });
      this.onApprovalRequest!(sessionId, approvalId);
      setTimeout(() => {
        if (this.pendingApprovals.delete(approvalId)) resolve(false);
      }, APPROVAL_TIMEOUT_MS);
    });
    if (approved) this.sessionGrants.add(sessionId);
    return approved;
  }

  // ── Connector lifecycle (called from the WS handlers) ──

  register(ws: ServerWebSocket<unknown>, info: { pid?: number; userDataDir?: string; version?: string }): ConnectorInfo {
    const connector: Connector = {
      id: this.nextConnectorId++,
      ws,
      pid: info.pid ?? null,
      userDataDir: info.userDataDir ?? null,
      version: info.version ?? null,
      connectedAt: Date.now(),
    };
    this.connectors.set(connector.id, connector);
    (ws.data as any).connectorId = connector.id;
    return connector;
  }

  unregister(ws: ServerWebSocket<unknown>): void {
    const id = (ws.data as any)?.connectorId;
    if (typeof id === 'number') this.connectors.delete(id);
  }

  onExtensionMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'reply' && msg.reqId) {
      const p = this.pendingReplies.get(msg.reqId);
      if (p) {
        clearTimeout(p.timer);
        this.pendingReplies.delete(msg.reqId);
        p.resolve(msg.payload);
      }
    } else if (msg.type === 'capture' && msg.entry) {
      this.captures.push(msg.entry);
      if (this.captures.length > CAPTURE_BUFFER_LIMIT) {
        this.captures.splice(0, this.captures.length - CAPTURE_BUFFER_LIMIT);
      }
    } else if (msg.type === 'log') {
      console.log(`[ext] ${msg.message}`);
    }
    // 'ready' acks from the extension need no daemon-side handling.
  }

  listTargets(): ConnectorInfo[] {
    return [...this.connectors.values()]
      .map(({ ws: _ws, ...info }) => info)
      .sort((a, b) => b.connectedAt - a.connectedAt);
  }

  // Pick the connector a browser command should go to. An explicit `filter`
  // (substring of userDataDir) always wins. Otherwise a session-scoped command
  // routes to the Chrome hosting that session's sidepanel chat, so the agent
  // stays inside its own browser. Only when neither pins a browser do we fall
  // back to the most recently connected one.
  private pickConnector(filter?: string, sessionId?: string): Connector | { error: string } {
    const all = [...this.connectors.values()].sort((a, b) => b.connectedAt - a.connectedAt);
    if (all.length === 0) return { error: 'no browser connected — open Chrome with the Airglow extension installed' };
    if (filter) {
      const match = all.find((c) => c.userDataDir?.includes(filter));
      if (!match) return { error: `no connected browser matches "${filter}" (${all.length} connected)` };
      return match;
    }
    if (sessionId) {
      const id = this.sessionConnectors.get(sessionId);
      if (id != null) {
        const bound = this.connectors.get(id);
        if (bound) return bound; // stale (browser closed/reconnected) → fall through
      }
    }
    return all[0];
  }

  private sendToExtension(connector: Connector, payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const reqId = String(this.nextReqId++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(reqId);
        resolve({ error: 'timeout waiting for the browser' });
      }, timeoutMs);
      this.pendingReplies.set(reqId, { resolve, timer });
      connector.ws.send(JSON.stringify({ t: 'ext', msg: { ...payload, reqId } }));
    });
  }

  // ── Browser commands (HTTP API surface for the CLI / agent harness) ──
  //
  // Command set is deliberately small: tabs, open, nav, eval, html, shot,
  // close, logs (+ attach/detach/read/entry for network capture). No reload
  // (the extension auto-reloads tabs on source change), no set (eval covers
  // it), no browser-process spawning.

  async command(cmd: string, args: Record<string, any>): Promise<any> {
    const picked = this.pickConnector(args.browser, args.sessionId);
    if ('error' in picked) return picked;
    const c = picked as Connector;

    switch (cmd) {
      case 'targets':
        return { targets: this.listTargets() };

      case 'tabs': {
        const sidepanelWindowId =
          typeof args.sessionId === 'string' ? this.sessionWindows.get(args.sessionId) ?? null : null;
        return this.sendToExtension(c, { type: 'tabs', sidepanelWindowId }, 5000);
      }

      case 'open': {
        if (!args.url) return { error: 'url required' };
        if (typeof args.sessionId === 'string' && args.sessionId) {
          const granted = await this.requireDebugWindowGrant(args.sessionId);
          if (!granted) {
            return { error: 'the user declined to let the agent open a browser window — continue without browser testing' };
          }
        }
        return this.sendToExtension(c, { type: 'newTab', url: args.url, active: args.active !== false }, 10000);
      }

      case 'nav': {
        if (!args.tabId || !args.url) return { error: 'tabId and url required' };
        return this.sendToExtension(c, { type: 'navigate', tabId: args.tabId, url: args.url }, 10000);
      }

      case 'close': {
        if (!args.tabId) return { error: 'tabId required' };
        return this.sendToExtension(c, { type: 'closeTab', tabId: args.tabId }, 10000);
      }

      case 'eval': {
        if (!args.tabId || !args.code) return { error: 'tabId and code required' };
        return this.sendToExtension(
          c,
          { type: 'eval', tabId: args.tabId, code: args.code, frame: args.frame ?? null, main: !!args.main },
          15000,
        );
      }

      case 'html': {
        if (!args.tabId) return { error: 'tabId required' };
        return this.sendToExtension(
          c,
          { type: 'getHtml', tabId: args.tabId, selector: args.selector ?? null, frame: args.frame ?? null },
          10000,
        );
      }

      case 'shot': {
        if (!args.tabId) return { error: 'tabId required' };
        const reply = await this.sendToExtension(c, { type: 'capture', tabId: args.tabId }, 15000);
        if (reply?.error) return reply;
        const dataUrl: string = reply?.dataUrl || '';
        const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/s);
        if (!m) return { error: 'unexpected capture format' };
        const path = join(SHOTS_DIR, `${Date.now()}-tab${args.tabId}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
        writeFileSync(path, Buffer.from(m[2], 'base64'));
        return { path };
      }

      case 'logs': {
        const reply = await this.sendToExtension(c, { type: 'logs' }, 5000);
        if (reply?.error) return reply;
        let entries: any[] = reply?.entries || [];
        if (args.level) entries = entries.filter((e) => e.level === args.level);
        if (args.source) entries = entries.filter((e) => e.source === args.source);
        entries = entries.slice(-(Number(args.n) || 50));
        return { entries, count: entries.length };
      }

      // ── Network capture (extension fetch/XHR interceptor; no CDP) ──

      case 'attach': {
        if (!args.tabId) return { error: 'tabId required' };
        return this.sendToExtension(c, { type: 'attach', tabId: args.tabId }, 5000);
      }

      case 'detach': {
        if (!args.tabId) return { error: 'tabId required' };
        return this.sendToExtension(c, { type: 'detach', tabId: args.tabId }, 5000);
      }

      case 'read': {
        let filtered = this.captures.filter(
          (e) => (args.tabId ? e.tabId === Number(args.tabId) : true) && e.ts > (Number(args.since) || 0),
        );
        if (args.noise !== true && args.noise !== '1') filtered = filtered.filter((e) => !isNoise(e));
        if (args.url) filtered = filtered.filter((e) => e.url?.includes(args.url));
        if (args.method) filtered = filtered.filter((e) => e.method === String(args.method).toUpperCase());
        this.lastReadResult = filtered;
        const entries = filtered.map((e, i) => ({
          i,
          method: e.method,
          status: e.status,
          transport: e.transport,
          url: e.url,
          reqLen: e.reqBody?.length || 0,
          resLen: e.resBody?.length || 0,
          resPreview: e.resBody ? e.resBody.slice(0, 200) : null,
        }));
        if (args.clear === true || args.clear === '1') {
          this.captures = args.tabId ? this.captures.filter((e) => e.tabId !== Number(args.tabId)) : [];
        }
        return { entries, count: entries.length };
      }

      case 'entry': {
        const idx = Number(args.i);
        if (!this.lastReadResult || idx < 0 || idx >= this.lastReadResult.length) {
          return { error: 'index out of range — run read first', total: this.lastReadResult?.length || 0 };
        }
        return this.lastReadResult[idx];
      }

      default:
        return { error: `unknown browser command: ${cmd}` };
    }
  }
}

const NOISE_PATTERNS = [
  'browser.pipe.aria.microsoft.com',
  'browser.events.data.microsoft.com',
  '/OneCollector/',
  '/Collector/3.0',
];

function isNoise(entry: NetCaptureEntry): boolean {
  const url = entry.url || '';
  if (/\.(js|css|svg|png|jpg|gif|woff2?|ico|map)(\?|$)/.test(url.split('?')[0])) return true;
  return NOISE_PATTERNS.some((p) => url.includes(p));
}
