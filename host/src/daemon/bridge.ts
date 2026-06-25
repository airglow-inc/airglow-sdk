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
import { writeFileSync, readFileSync } from 'node:fs';
import { SHOTS_DIR, DAEMON_LOG_PATH } from '../paths';

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

export class BrowserBridge {
  private connectors = new Map<number, Connector>();
  private nextConnectorId = 1;
  private pendingReplies = new Map<string, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextReqId = 1;
  private captures: NetCaptureEntry[] = [];
  private lastReadResult: NetCaptureEntry[] | null = null;

  // The per-session "Airglow" window+group lives in the EXTENSION
  // (chrome.storage), not here: window ids are per-browser and the daemon's
  // memory is wiped on restart, which would orphan a session's window. The
  // daemon just forwards `sessionId` on each command; the extension owns reuse,
  // role-labeling, and own-tab activation. See openAgentTab in background.ts.

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

  // connectorId → chrome.runtime.id the extension announced (in `identity`).
  // Per browser, because the dashboard URL differs between a dev build and the
  // Web Store build; resolved per session so each agent gets ITS browser's id.
  private connectorExtensionIds = new Map<number, string>();

  setSessionWindow(sessionId: string, windowId: number): void {
    this.sessionWindows.set(sessionId, windowId);
  }

  setSessionConnector(sessionId: string, ws: ServerWebSocket<unknown>): void {
    const id = (ws.data as any)?.connectorId;
    if (typeof id === 'number') this.sessionConnectors.set(sessionId, id);
  }

  setConnectorExtensionId(ws: ServerWebSocket<unknown>, extensionId: string): void {
    const id = (ws.data as any)?.connectorId;
    if (typeof id === 'number' && extensionId) this.connectorExtensionIds.set(id, extensionId);
  }

  // The chrome.runtime.id of the browser driving this session, or null. Used to
  // name that browser's dashboard chrome-extension:// URL in the agent prompt.
  extensionIdForSession(sessionId: string): string | null {
    const connectorId = this.sessionConnectors.get(sessionId);
    if (connectorId == null) return null;
    return this.connectorExtensionIds.get(connectorId) ?? null;
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
    if (typeof id === 'number') {
      this.connectors.delete(id);
      this.connectorExtensionIds.delete(id);
    }
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
      // Route to the Chrome whose sidepanel drives the session, so the agent's
      // tabs/evals/shots land in the same browser as the chat (not whichever
      // connected most recently). External agents have no binding → most recent.
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
        const type = typeof payload.type === 'string' ? payload.type : 'command';
        const profile = connector.userDataDir ? ` profile=${connector.userDataDir}` : '';
        resolve({ error: `${type} timed out after ${timeoutMs}ms waiting for browser connector ${connector.id}${profile}` });
      }, timeoutMs);
      this.pendingReplies.set(reqId, { resolve, timer });
      try {
        connector.ws.send(JSON.stringify({ t: 'ext', msg: { ...payload, reqId, timeoutMs } }));
      } catch (e: any) {
        clearTimeout(timer);
        this.pendingReplies.delete(reqId);
        resolve({ error: `failed to send browser ${String(payload.type ?? 'command')}: ${String(e?.message || e)}` });
      }
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
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : null;
        const sidepanelWindowId = sessionId ? this.sessionWindows.get(sessionId) ?? null : null;
        // The extension resolves this session's own window (and every other
        // agent session's) from its own storage to tag windows agent /
        // agent-other / user — the agent reads any tab but only acts in its own.
        return this.sendToExtension(c, { type: 'tabs', sidepanelWindowId, sessionId }, 5000);
      }

      case 'open': {
        if (!args.url) return { error: 'url required' };
        const sessionId = typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : null;
        const active = args.active !== false;
        // The extension keys the agent's window+group off sessionId (its own
        // chrome.storage, durable across daemon restarts); no sessionId →
        // anonymous shared window. windowId/groupId are internal bookkeeping —
        // the agent only targets a tab by `id`, so don't surface them.
        const reply = await this.sendToExtension(c, { type: 'newTab', url: args.url, active, sessionId }, 10000);
        return reply?.error ? reply : { id: reply?.id, url: reply?.url };
      }

      case 'nav': {
        if (!args.tabId || !args.url) return { error: 'tabId and url required' };
        const reply = await this.sendToExtension(c, { type: 'navigate', tabId: args.tabId, url: args.url, sessionId: typeof args.sessionId === 'string' ? args.sessionId : null }, 10000);
        return reply;
      }

      case 'close': {
        if (!args.tabId) return { error: 'tabId required' };
        return this.sendToExtension(c, { type: 'closeTab', tabId: args.tabId }, 10000);
      }

      case 'eval': {
        if (!args.tabId || !args.code) return { error: 'tabId and code required' };
        return this.sendToExtension(
          c,
          { type: 'eval', tabId: args.tabId, code: args.code, frame: args.frame ?? null, main: !!args.main, app: args.app ?? null, timeout: args.timeout, sessionId: typeof args.sessionId === 'string' ? args.sessionId : null },
          15000,
        );
      }

      case 'html': {
        if (!args.tabId) return { error: 'tabId required' };
        return this.sendToExtension(
          c,
          { type: 'getHtml', tabId: args.tabId, selector: args.selector ?? null, frame: args.frame ?? null, sessionId: typeof args.sessionId === 'string' ? args.sessionId : null },
          10000,
        );
      }

      case 'shot': {
        if (!args.tabId) return { error: 'tabId required' };
        const reply = await this.sendToExtension(c, { type: 'capture', tabId: args.tabId, timeout: args.timeout, sessionId: typeof args.sessionId === 'string' ? args.sessionId : null }, 15000);
        if (reply?.error) return reply;
        const dataUrl: string = reply?.dataUrl || '';
        const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/s);
        if (!m) return { error: 'unexpected capture format' };
        const path = join(SHOTS_DIR, `${Date.now()}-tab${args.tabId}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
        writeFileSync(path, Buffer.from(m[2], 'base64'));
        return { path };
      }

      case 'logs': {
        // One view over both streams the agent must watch: the browser-side
        // buffer (userscripts, app UIs, uncaught errors) and the daemon log
        // (bundle failures, RPC/server-function crashes). Merged chronologically
        // so a browser error and the server stack that caused it sit together.
        const reply = await this.sendToExtension(c, { type: 'logs' }, 5000);
        const browser: any[] = Array.isArray(reply?.entries) ? reply.entries : [];
        const daemon = args.source && args.source !== 'daemon' ? [] : readDaemonLog();
        let entries = [...browser, ...daemon].sort((a, b) => (a.ts || 0) - (b.ts || 0));
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

// The daemon tees console output to daemon.log, each line prefixed with an ISO
// timestamp (see setupLogTee). Parse the tail into log entries shaped like the
// browser buffer's so `logs` can interleave them. The log has no per-line level,
// so flag error-looking lines as 'error' (lets `--level error` surface daemon
// crashes alongside browser errors); everything else is 'info'.
const DAEMON_LOG_TAIL = 400;
const ERROR_RE = /\b(error|err|exception|fail(ed|ure)?|reject(ion|ed)?|fatal|throw|unhandled)\b/i;

function readDaemonLog(): { ts: number; level: 'info' | 'error'; source: string; message: string }[] {
  let text: string;
  try {
    text = readFileSync(DAEMON_LOG_PATH, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(Boolean).slice(-DAEMON_LOG_TAIL);
  const out: { ts: number; level: 'info' | 'error'; source: string; message: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s([\s\S]*)$/);
    const ts = m ? Date.parse(m[1]) : NaN;
    const message = m ? m[2] : line;
    out.push({
      ts: Number.isNaN(ts) ? 0 : ts,
      level: ERROR_RE.test(message) ? 'error' : 'info',
      source: 'daemon',
      message,
    });
  }
  return out;
}
