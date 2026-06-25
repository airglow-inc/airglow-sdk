// Airglow daemon — the singleton per-machine process that owns the workspace.
// Serves the app API (manifests, bundles, RPC) over HTTP, accepts connector
// WebSockets (one per running Chrome), and routes browser commands.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync, createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import {
  AIRGLOW_HOME,
  DAEMON_LOCK_PATH,
  DAEMON_LOG_PATH,
  DAEMON_RECORD_PATH,
  DEFAULT_DAEMON_PORT,
  SHOTS_DIR,
  STATE_DIR,
  WORKSPACE_CONFIG_PATH,
  ensureStateDirs,
  type DaemonRecord,
} from '../paths';
import { HOST_VERSION } from '../version';
import { ensureAirglowOnPath } from '../install';
import { EXTENSION_ORIGINS } from '../extension-ids';
import { SessionManager, stripImagesForTransport, type EventSink, type UserImage } from '../agent/session';
import type { AgentEvent } from '../agent/types';
import type { AgentIdentity } from '../agent/api';
import { AppServer } from './apps';
import { CatalogService } from './catalog';
import { reportApps, reportInstalls, type AppMeta } from './telemetry';
import { dedupeWorkspaceApps } from './dedupe-deps';
import { BrowserBridge } from './bridge';
import { createKeepAwake } from './keep-awake';
import { ConnectorService, DEFAULT_ACCOUNT, connectorGatewayUrl } from './connectors';
import { handleLlmAnthropicMessages } from './llm';
import { checkForUpdate, performUpdate } from './update';

function originAllowed(origin: string | null): boolean {
  if (!origin) return true; // curl, scripts, server-to-server
  if (EXTENSION_ORIGINS.includes(origin)) return true;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
  return false;
}

function readDaemonRecord(): DaemonRecord | null {
  try {
    return JSON.parse(readFileSync(DAEMON_RECORD_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export type DaemonProbeStatus =
  | { ok: true; record: DaemonRecord }
  | {
      ok: false;
      reason: 'no-record' | 'http-error' | 'wrong-service' | 'unreachable';
      record: DaemonRecord | null;
      message?: string;
      pidAlive?: boolean;
    };

function errorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const code = 'code' in e ? String((e as any).code) : '';
    const message = 'message' in e ? String((e as any).message) : '';
    return [code, message].filter(Boolean).join(': ') || String(e);
  }
  return String(e);
}

export async function probeDaemonStatus(): Promise<DaemonProbeStatus> {
  const record = readDaemonRecord();
  if (!record) return { ok: false, reason: 'no-record', record: null };
  try {
    const res = await fetch(`http://127.0.0.1:${record.port}/api/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: 'http-error',
        record,
        message: `/api/healthz returned HTTP ${res.status}`,
        pidAlive: pidAlive(record.pid),
      };
    }
    const data: any = await res.json();
    if (data?.service !== 'airglow-daemon') {
      return {
        ok: false,
        reason: 'wrong-service',
        record,
        message: `unexpected service ${JSON.stringify(data?.service)}`,
        pidAlive: pidAlive(record.pid),
      };
    }
    return { ok: true, record: { ...record, workspace: data.workspace ?? record.workspace } };
  } catch (e) {
    return {
      ok: false,
      reason: 'unreachable',
      record,
      message: errorMessage(e),
      pidAlive: pidAlive(record.pid),
    };
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export async function probeDaemon(): Promise<DaemonRecord | null> {
  const status = await probeDaemonStatus();
  return status.ok ? status.record : null;
}

// Mirror console output to state/daemon.log (truncated each run) so agents
// and the maintainer can read errors after the fact. Bun's console writes to
// the fd directly (not through process.stdout.write), so the console methods
// themselves are wrapped.
function setupLogTee(): void {
  try {
    const stream = createWriteStream(DAEMON_LOG_PATH, { flags: 'w' });
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    for (const method of ['log', 'error', 'warn', 'info'] as const) {
      const orig = console[method].bind(console);
      console[method] = (...args: any[]) => {
        try {
          const line = args.map((a) => (typeof a === 'string' ? a : Bun.inspect(a))).join(' ');
          stream.write(`${new Date().toISOString()} ${stripAnsi(line)}\n`);
        } catch {}
        orig(...args);
      };
    }
  } catch {}
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export async function runDaemon(argv: string[]): Promise<void> {
  ensureStateDirs();

  // Workspace resolution: explicit flag > env > persisted preference > home.
  // An explicit flag also persists, so daemons later auto-spawned by a
  // connector serve the same workspace.
  let explicitWorkspace: string | null = null;
  let requestedPort = DEFAULT_DAEMON_PORT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' && argv[i + 1]) explicitWorkspace = resolve(argv[++i]);
    if (argv[i] === '--port' && argv[i + 1]) requestedPort = Number(argv[++i]);
  }
  let workspace = explicitWorkspace ?? AIRGLOW_HOME;
  if (!explicitWorkspace) {
    try {
      const saved = readFileSync(WORKSPACE_CONFIG_PATH, 'utf8').trim();
      if (saved && existsSync(saved)) workspace = saved;
    } catch {}
  }

  // ── Singleton ──
  const existing = await probeDaemon();
  if (existing) {
    if (!explicitWorkspace) {
      // Auto-spawned (connector) or bare start: whatever daemon is already
      // running wins — connectors just attach to it.
      console.log(`airglow daemon already running on http://127.0.0.1:${existing.port} (workspace ${existing.workspace})`);
      process.exit(0);
    }
    // Explicit --workspace expresses user intent ("THIS process should be the
    // daemon") — take over even when the workspace matches, so a restart
    // picks up new code and environment.
    console.log(`taking over from daemon pid ${existing.pid} (workspace ${existing.workspace})`);
    try { process.kill(existing.pid, 'SIGTERM'); } catch {}
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await probeDaemon())) {
      await Bun.sleep(200);
    }
    if (await probeDaemon()) {
      console.error(`daemon pid ${existing.pid} did not exit; kill it manually.`);
      process.exit(1);
    }
  }
  if (explicitWorkspace) {
    try { writeFileSync(WORKSPACE_CONFIG_PATH, `${explicitWorkspace}\n`); } catch {}
  }
  // Lock guards the spawn race (two connectors starting at once). The record
  // probe above already handled the steady state.
  try {
    writeFileSync(DAEMON_LOCK_PATH, String(process.pid), { flag: 'wx' });
  } catch {
    const lockPid = Number(readFileSync(DAEMON_LOCK_PATH, 'utf8').trim() || 0);
    if (lockPid && pidAlive(lockPid)) {
      // The other process is starting up; let it win.
      console.log(`airglow daemon is starting under pid ${lockPid}; exiting`);
      process.exit(0);
    }
    unlinkSync(DAEMON_LOCK_PATH);
    writeFileSync(DAEMON_LOCK_PATH, String(process.pid), { flag: 'wx' });
  }

  setupLogTee();

  // Self-update swaps the binary without re-running `airglow install` — so a
  // compiled daemon re-seeds the managed workspace content (docs, AGENTS.md,
  // shared/) whenever the binary version differs from the last seeding.
  if (Bun.main.includes('$bunfs')) {
    const { seededVersion, seedWorkspace } = await import('../seed');
    if (seededVersion() !== HOST_VERSION) {
      console.log(`binary version changed (seeded by ${seededVersion() || 'never'}, running ${HOST_VERSION}) — re-seeding workspace`);
      await seedWorkspace().catch((e) => console.error(`re-seed failed: ${e?.message ?? e}`));
    }
  }

  // Agent config comes EXCLUSIVELY from state/agent.env. Inherited values for
  // these keys are scrubbed first — a stray shell export (or Chrome's env)
  // must never silently flip the agent's upstream or model; one file is the
  // whole truth. Other keys in agent.env are fill-only.
  const AGENT_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'AIRGLOW_GATEWAY_URL',
    'AIRGLOW_AGENT_PROMPT_FILE',
  ];
  for (const key of AGENT_ENV_KEYS) delete process.env[key];
  try {
    const envFile = readFileSync(join(STATE_DIR, 'agent.env'), 'utf8');
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
    }
  } catch {}

  // Pin the daemon's PATH to a deterministic minimal set so that everything the
  // daemon spawns directly (bundler, RPC, the Tailwind build, tar/cp) behaves
  // identically no matter how the daemon was launched. Without this, a
  // terminal-launched daemon inherits the dev shell's rich PATH (Homebrew, node,
  // …) while the production daemon — auto-spawned by the Chrome native-messaging
  // connector — gets launchd's bare PATH, so any accidental reliance on a
  // user-installed tool works in dev and silently fails for users (this is the
  // bug that broke per-app Tailwind: `.bin/tailwindcss`'s node shebang couldn't
  // find `node`). Minimal — not a curated PATH that includes Homebrew — is the
  // point: the daemon must be self-sufficient (it resolves its own tools via
  // process.execPath / node_modules), and pinning minimal makes any leak break
  // loudly in local testing too. The agent's bash tool is unaffected: it spawns
  // a login shell (`/bin/bash -lc`), so macOS path_helper rebuilds the full
  // user PATH for agent commands regardless of what the daemon's PATH is.
  if (process.platform !== 'win32') {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  }

  if (process.env.ANTHROPIC_API_KEY) {
    console.log('agent upstream: direct Anthropic API (ANTHROPIC_API_KEY in state/agent.env)');
  } else {
    console.log(`agent upstream: gateway ${process.env.AIRGLOW_GATEWAY_URL || 'https://api.airglow.dev (default)'}`);
  }

  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
  // Prune any app-local dependency copies that merely shadow the hoisted
  // workspace root (a per-app install's peer copy of react, …). A duplicated
  // singleton bundles twice → "Invalid hook call" at render. See dedupe-deps.ts.
  dedupeWorkspaceApps(workspace);
  const apps = new AppServer(workspace);
  const catalog = new CatalogService(workspace, apps);
  const bridge = new BrowserBridge();
  const connectors = new ConnectorService(workspace);

  // ── Agent sessions ──
  // Events stream to the connector whose chat client started the session.
  const sessionConnectors = new Map<string, Bun.ServerWebSocket<unknown>>();

  // Per-session live event buffer for lossless sidepanel reconnect. Each
  // emitted event gets a monotonic per-session seq; a reopened (or
  // service-worker-recycled) panel replays everything from the current turn,
  // recovering events emitted while it was detached — neither the background
  // relay nor the connector buffers anything. Cleared at each turn start so it
  // only ever holds the current turn; the seq counter keeps climbing so any
  // other open panel's dedup stays correct across turns.
  const EVENT_BUF_CAP = 800;
  const eventLog = new Map<string, { seq: number; events: { seq: number; event: AgentEvent }[] }>();
  function recordEvent(sessionId: string, event: AgentEvent): number {
    let log = eventLog.get(sessionId);
    if (!log) eventLog.set(sessionId, (log = { seq: 0, events: [] }));
    const seq = ++log.seq;
    log.events.push({ seq, event });
    if (log.events.length > EVENT_BUF_CAP) log.events.splice(0, log.events.length - EVENT_BUF_CAP);
    return seq;
  }
  const connectorIdentities = new WeakMap<object, AgentIdentity>();
  // Last identity any connector announced — last-resort fallback for loopbacks
  // that carry neither an Authorization header nor an RPC session nonce. This
  // is GLOBAL, so it picks the wrong user when several browsers are connected;
  // rpcConnectorIdentities below is what makes server-function loopbacks resolve
  // the right one.
  let lastConnectorIdentity: AgentIdentity | null = null;

  // Per-RPC connector/LLM identity: an opaque nonce → the identity of the
  // browser that invoked the RPC. Handed to the server-function subprocess as
  // AIRGLOW_CONNECTOR_SESSION and echoed back (X-Airglow-Connector-Session) on
  // its airglow.connectors / airglow.llm loopbacks, so the daemon attaches that
  // user's token even with multiple browsers connected. The token itself never
  // enters the subprocess. Entries live only for the duration of one RPC.
  const rpcConnectorIdentities = new Map<string, AgentIdentity>();
  let rpcConnectorSessionSeq = 0;

  // Report the user's current installed catalog apps to the cloud (install,
  // uninstall, identity announce). reportInstalls dedupes + is fire-and-forget.
  const syncInstallTelemetry = () => reportInstalls(lastConnectorIdentity, Object.keys(catalog.provenance()));

  // Report the apps the user is building (id + name + description from each
  // workspace manifest). Fed the freshly-scanned manifests where we already
  // have them (the manifests route) to avoid a second scan; reportApps dedupes
  // so it only hits the cloud when an app appears or its name/description edits.
  const syncAppTelemetry = (manifests: { id?: unknown; name?: unknown; description?: unknown }[]) => {
    const apps: AppMeta[] = [];
    for (const m of manifests) {
      if (typeof m?.id !== 'string' || !m.id) continue;
      apps.push({
        id: m.id,
        name: typeof m.name === 'string' ? m.name : undefined,
        description: typeof m.description === 'string' ? m.description : undefined,
      });
    }
    reportApps(lastConnectorIdentity, apps);
  };

  function sendExt(ws: Bun.ServerWebSocket<unknown>, m: Record<string, unknown>): void {
    try { ws.send(JSON.stringify({ t: 'ext', msg: m })); } catch {}
  }

  const sink: EventSink = (sessionId, event) => {
    const seq = recordEvent(sessionId, event);
    const ws = sessionConnectors.get(sessionId);
    if (ws) sendExt(ws, { type: 'agent:event', sessionId, event, seq });
  };

  const keepAwake = createKeepAwake();
  const agents = new SessionManager(
    {
      workspace,
      daemonOrigin: () => `http://127.0.0.1:${server.port}`,
      daemonLogPath: DAEMON_LOG_PATH,
      extensionId: (sessionId: string) => bridge.extensionIdForSession(sessionId),
      airglowBinDir: ensureAirglowOnPath(),
      keepAwake,
      listApps: async () => {
        const manifests = await apps.scanManifests();
        const result: { id: string; dir: string }[] = [];
        for (const m of manifests) {
          const dir = await apps.resolveAppDir(m.id);
          if (dir) result.push({ id: m.id, dir: relative(workspace, dir) });
        }
        return result;
      },
      // The tab the user is looking at in the session's Chrome window: the
      // `current` tab of the `chatWindow` from the bridge's `tabs` reply.
      // Capped so a slow/unresponsive browser never stalls the turn.
      currentTab: async (sessionId) => {
        try {
          const res = await Promise.race([
            bridge.command('tabs', { sessionId }),
            new Promise<null>((r) => setTimeout(() => r(null), 2500)),
          ]);
          const windows = (res as any)?.windows;
          if (!Array.isArray(windows)) return null;
          const chat = windows.find((w: any) => w?.chatWindow) ?? windows[0];
          const tab = chat?.tabs?.find((t: any) => t?.current);
          if (!tab || typeof tab.id !== 'number') return null;
          return {
            id: tab.id,
            title: typeof tab.title === 'string' ? tab.title : '',
            url: typeof tab.url === 'string' ? tab.url : undefined,
          };
        } catch {
          return null;
        }
      },
      // Gateway rejected this session's token (AUTH_SESSION_INVALID). Ask its
      // connector to silently re-mint (no UI while Google is signed in), then
      // wait for the refreshed `identity` message and hand back the new token
      // so the turn retries. Null when there's no connector or the refresh
      // didn't land in time (e.g. signed out of Google → falls through to the
      // surfaced error).
      refreshAuth: async (sessionId) => {
        const ws = sessionConnectors.get(sessionId);
        if (!ws) return null;
        const before = connectorIdentities.get(ws)?.authToken ?? null;
        sendExt(ws, { type: 'agent:auth_refresh', sessionId });
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await Bun.sleep(200);
          const now = connectorIdentities.get(ws)?.authToken ?? null;
          // Any change ends the wait: a new token → retry with it; the token
          // cleared to null → the extension gave up (no silent session), so
          // surface the error promptly instead of stalling the full 10s.
          if (now !== before) return now;
        }
        return null;
      },
    },
    sink,
  );

  // The gateway URL the daemon booted with (agent.env or unset). A non-empty
  // override from the extension Settings wins; clearing it restores this.
  const bootGatewayUrl = process.env.AIRGLOW_GATEWAY_URL;
  function applyGatewayOverride(raw: unknown): void {
    const url = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
    if (url && !/^https?:\/\//.test(url)) {
      console.log(`ignoring invalid gateway URL override: ${url}`);
      return;
    }
    const next = url || bootGatewayUrl;
    if (process.env.AIRGLOW_GATEWAY_URL === next || (!process.env.AIRGLOW_GATEWAY_URL && !next)) return;
    if (next) process.env.AIRGLOW_GATEWAY_URL = next;
    else delete process.env.AIRGLOW_GATEWAY_URL;
    console.log(`agent gateway URL ${url ? `overridden: ${url}` : 'restored to default'}`);
  }

  // Chat-client messages arriving from a connector (the extension side).
  function handleAgentMessage(ws: Bun.ServerWebSocket<unknown>, m: any): boolean {
    switch (m.type) {
      case 'identity':
        connectorIdentities.set(ws, {
          userId: typeof m.userId === 'string' ? m.userId : null,
          email: typeof m.email === 'string' ? m.email : null,
          authToken: typeof m.authToken === 'string' && m.authToken ? m.authToken : null,
        });
        lastConnectorIdentity = connectorIdentities.get(ws as object) ?? null;
        if (typeof m.extensionId === 'string' && m.extensionId) bridge.setConnectorExtensionId(ws, m.extensionId);
        if ('gatewayUrl' in m) applyGatewayOverride(m.gatewayUrl);
        syncInstallTelemetry(); // now we know who to attribute installs to
        apps.scanManifests().then(syncAppTelemetry).catch(() => {});
        return true;
      case 'agent:start': {
        const identity = connectorIdentities.get(ws) ?? { userId: null, email: null, authToken: null };
        const session = agents.prepare(
          identity,
          typeof m.sessionId === 'string' && m.sessionId ? m.sessionId : undefined,
        );
        // Route BEFORE running — the session_started event fires immediately.
        sessionConnectors.set(session.id, ws);
        // Bind the session to the Chrome it's driven from: window id (so `tabs`
        // marks that window's active tab `current`) and connector (so the
        // agent's browser commands route to THIS Chrome, not whichever
        // connected most recently — keeps the agent inside its own browser).
        if (typeof m.windowId === 'number') bridge.setSessionWindow(session.id, m.windowId);
        bridge.setSessionConnector(session.id, ws);
        // New turn → drop the previous turn's buffered events (keep the seq
        // counter climbing so other open panels' dedup survives the reset).
        const prevLog = eventLog.get(session.id);
        if (prevLog) prevLog.events = [];
        const images: UserImage[] = Array.isArray(m.images)
          ? m.images
              .filter((im: any) => typeof im?.media_type === 'string' && typeof im?.data === 'string')
              .slice(0, 4)
          : [];
        agents.run(session, String(m.text ?? ''), images.length ? images : undefined);
        return true;
      }
      case 'agent:stop': {
        if (typeof m.sessionId === 'string') {
          console.log(`agent:stop for ${m.sessionId}`);
          agents.get(m.sessionId)?.stop();
        }
        return true;
      }
      case 'agent:followup': {
        // A message the user sent while the turn was (apparently) still running.
        const session = typeof m.sessionId === 'string' ? agents.get(m.sessionId) : null;
        if (!session) return true;
        // Keep this panel as the session's event route (same binding as a turn).
        sessionConnectors.set(session.id, ws);
        bridge.setSessionConnector(session.id, ws);
        if (typeof m.windowId === 'number') bridge.setSessionWindow(session.id, m.windowId);
        const images: UserImage[] = Array.isArray(m.images)
          ? m.images
              .filter((im: any) => typeof im?.media_type === 'string' && typeof im?.data === 'string')
              .slice(0, 4)
          : [];
        const text = String(m.text ?? '');
        if (session.running) {
          // Surface the bubble to every panel + the resync buffer now; the loop
          // weaves the message into history at its next boundary.
          sink(session.id, {
            type: 'user_message',
            text,
            imageCount: images.length || undefined,
            clientId: typeof m.clientId === 'string' ? m.clientId : undefined,
          });
          session.enqueueFollowup(text, images.length ? images : undefined, typeof m.clientId === 'string' ? m.clientId : undefined);
        } else {
          // The turn ended in the gap before this arrived (the panel hadn't seen
          // turn_done yet) — run it as a fresh turn. The optimistic echo stays;
          // history reconstruction covers a later reload, like a normal send.
          const prevLog = eventLog.get(session.id);
          if (prevLog) prevLog.events = [];
          // It runs immediately as the turn's opening message, not queued —
          // clear the panel's optimistic "in queue" pill right away.
          if (typeof m.clientId === 'string' && m.clientId) sink(session.id, { type: 'followup_injected', clientIds: [m.clientId] });
          agents.run(session, text, images.length ? images : undefined);
        }
        return true;
      }
      case 'agent:sessions':
        sendExt(ws, { type: 'agent:sessions:result', reqId: m.reqId, sessions: agents.list() });
        return true;
      case 'agent:history': {
        const session = typeof m.sessionId === 'string' ? agents.get(m.sessionId) : null;
        const log = typeof m.sessionId === 'string' ? eventLog.get(m.sessionId) : undefined;
        const running = session?.running ?? false;
        const allMessages = session?.getMessages() ?? [];
        const allTimes = session?.getMessageTimes() ?? [];
        // For a live turn, hand back completed turns from persisted history plus
        // the in-flight user message and the live event buffer — the panel
        // replays the buffer to render the running turn exactly as it streamed.
        // For a finished session, the full transcript is the whole story.
        const tsi = running && session ? session.getTurnStartIndex() : allMessages.length;
        const turnUser = running ? allMessages[tsi] ?? null : null;
        sendExt(ws, {
          type: 'agent:history:result',
          reqId: m.reqId,
          sessionId: m.sessionId,
          meta: session?.meta ?? null,
          messages: stripImagesForTransport(running ? allMessages.slice(0, tsi) : allMessages),
          times: running ? allTimes.slice(0, tsi) : allTimes,
          running,
          turnUserMessage: turnUser ? stripImagesForTransport([turnUser])[0] ?? null : null,
          events: running ? log?.events ?? [] : [],
          turnStartedAt: running ? session?.getTurnStartedAt() ?? null : null,
          lastSeq: log?.seq ?? 0,
        });
        if (session) sessionConnectors.set(session.id, ws);
        return true;
      }
      default:
        return false;
    }
  }

  // Candidate font dirs: managed workspace assets first, then the in-repo
  // extension fonts (source-checkout workflow).
  const fontDirs = [
    join(workspace, 'shared', 'fonts'),
    join(import.meta.dir, '..', '..', '..', 'extension', 'public', 'fonts'),
  ];

  // Secret gating the privileged `/ws` socket (agent control, connector
  // registration). Initialised before the server starts so the closure below
  // always sees it; persisted to the daemon record for the connector to read.
  const daemonToken = randomBytes(32).toString('hex');

  async function handleRequest(req: Request, server: Bun.Server<any>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const origin = req.headers.get('origin');

    if (pathname === '/ws') {
      // The WS upgrade runs before any CORS/origin gate (browsers don't apply
      // same-origin policy to WebSockets), so this token is the actual access
      // control: only a client that can read the 0600 daemon record (the native
      // connector) knows it. A web page cannot, so it cannot drive the agent.
      if (url.searchParams.get('token') !== daemonToken) {
        return jsonResponse(401, { error: 'unauthorized' });
      }
      if (server.upgrade(req, { data: {} as any })) return undefined;
      return jsonResponse(400, { error: 'websocket upgrade failed' });
    }

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!originAllowed(origin)) {
      return jsonResponse(403, { error: 'origin not allowed', origin }, cors);
    }

    const respond = (status: number, contentType: string, body: string | Uint8Array) =>
      new Response(body, { status, headers: { 'Content-Type': contentType, ...cors } });
    const respondJson = (status: number, body: unknown) => jsonResponse(status, body, cors);

    // A server-function loopback (airglow.connectors / airglow.llm) carries no
    // Authorization but tags itself with the RPC session nonce, so we resolve
    // the identity of the browser that actually invoked the RPC — not the global
    // lastConnectorIdentity, which is wrong when several browsers are connected.
    const connectorSessionId = req.headers.get('x-airglow-connector-session');
    const sessionIdentity = connectorSessionId ? rpcConnectorIdentities.get(connectorSessionId) ?? null : null;

    try {
      if (pathname === '/api/healthz' && req.method === 'GET') {
        return respondJson(200, { ok: true, service: 'airglow-daemon', version: HOST_VERSION, workspace });
      }

      if (pathname === '/api/daemon/status' && req.method === 'GET') {
        return respondJson(200, {
          ok: true,
          version: HOST_VERSION,
          workspace,
          pid: process.pid,
          browsers: bridge.listTargets(),
        });
      }

      // Self-update: check is a cheap GitHub query; update swaps the binary
      // and respawns via takeover (this process dies on success).
      if (pathname === '/api/daemon/update-check' && req.method === 'GET') {
        try {
          return respondJson(200, { ok: true, ...(await checkForUpdate()) });
        } catch (e: any) {
          return respondJson(502, { error: String(e?.message ?? e) });
        }
      }
      if (pathname === '/api/daemon/update' && req.method === 'POST') {
        try {
          const { updatingTo } = await performUpdate(workspace);
          console.log(`self-update: swapped binary, restarting as v${updatingTo}`);
          return respondJson(200, { ok: true, updatingTo });
        } catch (e: any) {
          return respondJson(400, { error: String(e?.message ?? e) });
        }
      }

      if (pathname === '/api/apps/manifests' && req.method === 'GET') {
        const manifests = await apps.scanManifests();
        // The extension refetches manifests whenever the workspace app set
        // changes (new app, edited manifest), so this is the natural "app data
        // changed" hook for build telemetry. Reuses the scan we just did.
        syncAppTelemetry(manifests);
        return respondJson(200, manifests);
      }

      // Install a catalog app into the workspace (apps/<id>) + record provenance.
      if (pathname === '/api/catalog/install' && req.method === 'POST') {
        const body: any = await req.json().catch(() => null);
        const appId = body?.appId;
        if (typeof appId !== 'string') return respondJson(400, { error: 'expected { appId }' });
        const result = await catalog.install(appId);
        if (result.ok) syncInstallTelemetry();
        return respondJson(result.ok ? 200 : 500, result);
      }
      // Provenance for installed apps: which are from the catalog + locally modified.
      if (pathname === '/api/catalog/installed' && req.method === 'GET') {
        return respondJson(200, { ok: true, provenance: catalog.provenance() });
      }
      // Uninstall an app: delete its workspace folder + daemon sidecars.
      if (pathname === '/api/apps/uninstall' && req.method === 'POST') {
        const body: any = await req.json().catch(() => null);
        const appId = body?.appId;
        if (typeof appId !== 'string') return respondJson(400, { error: 'expected { appId }' });
        const result = await catalog.uninstall(appId);
        if (result.ok) syncInstallTelemetry();
        return respondJson(result.ok ? 200 : 500, result);
      }

      // airglow.llm from locally-served apps — proxied to the LLM gateway
      // (or straight to Anthropic in dev). See daemon/llm.ts.
      if (pathname === '/api/llm/anthropic/messages' && req.method === 'POST') {
        const [status, data] = await handleLlmAnthropicMessages(req, sessionIdentity ?? lastConnectorIdentity);
        return respondJson(status, data);
      }

      // Env keys declared by installed apps (manifest.server_env), grouped
      // per app, with set-ness but never values — the UI shows status and
      // writes, only the server-function subprocess ever reads real values.
      if (pathname === '/api/env/status' && req.method === 'GET') {
        const manifests = await apps.scanManifests();
        return respondJson(200, { ok: true, apps: apps.envStatus(manifests) });
      }
      // Set UI-entered secrets for one app ('' deletes a key).
      if (pathname === '/api/env/set' && req.method === 'POST') {
        const body: any = await req.json().catch(() => null);
        const appId = body?.appId;
        const entries = body?.entries;
        if (typeof appId !== 'string' || !/^[\w-]+$/.test(appId)) {
          return respondJson(400, { error: 'expected { appId, entries: { KEY: value } }' });
        }
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
          return respondJson(400, { error: 'expected { appId, entries: { KEY: value } }' });
        }
        for (const [key, value] of Object.entries(entries)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\n')) {
            return respondJson(400, { error: `invalid entry: ${key}` });
          }
        }
        apps.setAppSecrets(appId, entries as Record<string, string>);
        const manifests = await apps.scanManifests();
        return respondJson(200, { ok: true, apps: apps.envStatus(manifests) });
      }
      // Reveal one stored secret value (local-only, on explicit user action) so
      // the UI can show a saved key. The value goes only to the same-origin app
      // page on this machine — the surface that wrote it.
      if (pathname === '/api/env/reveal' && req.method === 'GET') {
        const u = new URL(req.url);
        const appId = u.searchParams.get('appId') || '';
        const key = u.searchParams.get('key') || '';
        if (!/^[\w-]+$/.test(appId) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return respondJson(400, { error: 'expected appId & key' });
        }
        return respondJson(200, { ok: true, value: apps.revealSecret(appId, key) });
      }

      // Screenshots taken by `airglow browser shot` — served so the sidepanel
      // can render them inline.
      const shotMatch = pathname.match(/^\/api\/shots\/([a-zA-Z0-9_.-]+\.(?:jpg|jpeg|png|webp))$/);
      if (shotMatch && req.method === 'GET') {
        const p = join(SHOTS_DIR, shotMatch[1]);
        if (!existsSync(p)) return respondJson(404, { error: 'shot not found' });
        return new Response(Bun.file(p), { headers: { 'Cache-Control': 'private, max-age=86400', ...cors } });
      }

      const fontMatch = pathname.match(/^\/api\/fonts\/([a-zA-Z0-9_.-]+\.woff2)$/);
      if (fontMatch && req.method === 'GET') {
        for (const dir of fontDirs) {
          const p = join(dir, fontMatch[1]);
          if (existsSync(p)) {
            return new Response(Bun.file(p), {
              headers: { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable', ...cors },
            });
          }
        }
        return respondJson(404, { error: `font ${fontMatch[1]} not found` });
      }

      // Connectors: Composio-backed third-party tool access. Consumed by the
      // SDK (via the extension), the `airglow toolkit` CLI, and the dashboard.
      if (pathname.startsWith('/api/connectors/')) {
        const action = pathname.slice('/api/connectors/'.length);

        // Gateway mode (production): no local COMPOSIO_API_KEY → forward
        // verbatim to the cloud, which holds the shared project key and mints
        // the connector scope from the verified session token. Identity:
        // request Authorization wins (extension-originated calls); CLI and
        // server-function loopbacks fall back to the last announced identity.
        if (!connectors.hasApiKey()) {
          const gwBase = connectorGatewayUrl();
          const headers: Record<string, string> = {};
          const auth = req.headers.get('authorization');
          // Precedence: a real Authorization header (extension-originated call)
          // wins; then the RPC session's identity (server-function loopback);
          // then the global last-announced identity as a last resort.
          if (auth) headers['authorization'] = auth;
          else if (sessionIdentity?.authToken) headers['authorization'] = `Bearer ${sessionIdentity.authToken}`;
          else if (lastConnectorIdentity?.authToken) headers['authorization'] = `Bearer ${lastConnectorIdentity.authToken}`;
          const accountDelete = action.match(/^accounts\/([A-Za-z0-9_-]+)$/);
          let target = `${gwBase}/api/connectors/${action}${url.search}`;
          let init: RequestInit = { method: req.method, headers };
          if (accountDelete && req.method === 'DELETE') {
            target = `${gwBase}/api/connectors/accounts?id=${encodeURIComponent(accountDelete[1])}`;
          } else if (req.method === 'POST') {
            init = {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: await req.text(),
            };
          }
          try {
            const res = await fetch(target, { ...init, signal: AbortSignal.timeout(60_000) });
            const text = await res.text();
            let data: any;
            try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300), code: 'CONNECTOR_UPSTREAM_ERROR' }; }
            return respondJson(res.status, data);
          } catch (e: any) {
            return respondJson(502, {
              error: `connector gateway unreachable: ${e?.message ?? e}`,
              code: 'CONNECTOR_GATEWAY_UNREACHABLE',
            });
          }
        }

        if (action === 'accounts' && req.method === 'GET') {
          return respondJson(200, { ok: true, accounts: await connectors.listAccounts() });
        }
        const accountMatch = action.match(/^accounts\/([A-Za-z0-9_-]+)$/);
        if (accountMatch && req.method === 'DELETE') {
          return respondJson(200, await connectors.deleteAccount(accountMatch[1]));
        }
        if (action === 'toolkits' && req.method === 'GET') {
          const q = url.searchParams.get('search') ?? '';
          return respondJson(200, { ok: true, toolkits: await connectors.searchToolkits(q) });
        }
        if (action === 'tools' && req.method === 'GET') {
          const toolkit = url.searchParams.get('toolkit');
          if (!toolkit) return respondJson(400, { error: 'missing toolkit param' });
          return respondJson(200, {
            ok: true,
            tools: await connectors.listTools(toolkit, url.searchParams.get('search') ?? undefined),
          });
        }
        if (action === 'schema' && req.method === 'GET') {
          const tool = url.searchParams.get('tool');
          if (!tool) return respondJson(400, { error: 'missing tool param' });
          return respondJson(200, { ok: true, tool: await connectors.toolSchema(tool) });
        }

        if (req.method === 'POST' && ['initiate', 'status', 'wait', 'disconnect', 'execute'].includes(action)) {
          const body: any = await req.json().catch(() => ({}));
          if (action === 'wait') {
            if (typeof body?.connectedAccountId !== 'string') {
              return respondJson(400, { error: 'expected { connectedAccountId, timeoutMs? }' });
            }
            return respondJson(200, await connectors.wait(body.connectedAccountId, Number(body.timeoutMs) || 10_000));
          }
          const appId = body?.appId;
          if (typeof appId !== 'string' || !/^[\w-]+$/.test(appId)) {
            return respondJson(400, { error: 'invalid appId' });
          }
          const account = typeof body?.account === 'string' && body.account ? body.account : DEFAULT_ACCOUNT;
          if (action === 'execute') {
            if (typeof body?.tool !== 'string' || !/^[A-Z0-9_]+$/.test(body.tool)) {
              return respondJson(400, { error: 'invalid tool slug' });
            }
            return respondJson(200, await connectors.execute(appId, body.tool, body.arguments ?? {}, account));
          }
          const toolkit = body?.toolkit;
          if (typeof toolkit !== 'string' || !/^[a-z0-9_-]+$/i.test(toolkit)) {
            return respondJson(400, { error: 'invalid toolkit slug' });
          }
          if (action === 'initiate') return respondJson(200, await connectors.initiate(appId, toolkit.toLowerCase(), account));
          if (action === 'status') return respondJson(200, await connectors.status(appId, toolkit.toLowerCase(), account));
          if (action === 'disconnect') return respondJson(200, await connectors.disconnect(appId, toolkit.toLowerCase(), account));
        }
        return respondJson(404, { error: 'unknown connectors endpoint' });
      }

      // Browser bridge: POST /api/browser/<cmd> with JSON args.
      const browserMatch = pathname.match(/^\/api\/browser\/([a-z]+)$/);
      if (browserMatch && req.method === 'POST') {
        const args = await req.json().catch(() => ({}));
        const result = await bridge.command(browserMatch[1], args ?? {});
        return respondJson(result?.error ? 500 : 200, result);
      }

      const appMatch = pathname.match(/^\/api\/apps\/([^/]+)\/(.+)$/);
      if (appMatch) {
        const [, appId, rest] = appMatch;

        if (rest === 'ui' && req.method === 'GET') {
          const [status, contentType, body] = await apps.handleUi(appId);
          return respond(status, contentType, body);
        }
        if (rest === 'ui-bundle' && req.method === 'GET') {
          const [status, contentType, body] = await apps.handleUiBundle(appId);
          return respond(status, contentType, body);
        }
        if (rest === 'userscript' && req.method === 'GET') {
          const file = url.searchParams.get('file');
          if (!file) return respondJson(400, { error: 'missing file param' });
          const format = url.searchParams.get('format') || 'iife';
          const [status, contentType, body] = await apps.handleUserscript(appId, file, format);
          return respond(status, contentType, body);
        }
        const rpcMatch = rest.match(/^rpc\/(.+)$/);
        if (rpcMatch && req.method === 'POST') {
          const body = await req.json().catch(() => ({}));
          // Pin this RPC's server-function loopbacks (airglow.connectors /
          // airglow.llm) to the identity of the browser that invoked it. The
          // token stays in the daemon; only the opaque nonce reaches the app
          // subprocess.
          let sessionNonce: string | undefined;
          const rpcAuth = req.headers.get('authorization');
          const rpcUserId = req.headers.get('x-airglow-user-id');
          if (rpcAuth || rpcUserId) {
            sessionNonce = `rpc-${++rpcConnectorSessionSeq}`;
            rpcConnectorIdentities.set(sessionNonce, {
              userId: rpcUserId,
              email: req.headers.get('x-airglow-user-email'),
              authToken: rpcAuth ? rpcAuth.replace(/^Bearer\s+/i, '') : null,
            });
          }
          try {
            const [status, data] = await apps.handleRpc(appId, rpcMatch[1], body, sessionNonce);
            return respondJson(status, data);
          } catch (e: any) {
            console.error(`[airglow/${appId}] rpc ${rpcMatch[1]} failed: ${e?.message || e}`);
            return respondJson(500, { error: String(e?.message || e) });
          } finally {
            if (sessionNonce) rpcConnectorIdentities.delete(sessionNonce);
          }
        }
      }

      return respondJson(404, { error: 'not found' });
    } catch (e: any) {
      return respondJson(500, { error: String(e?.message || e), ...(e?.code ? { code: e.code } : {}) });
    }
  }

  let server: Bun.Server<any>;
  const serveOptions = {
    hostname: '127.0.0.1',
    fetch: handleRequest,
    websocket: {
      open(_ws: Bun.ServerWebSocket<unknown>) {},
      message(ws: Bun.ServerWebSocket<unknown>, raw: string | Buffer) {
        let msg: any;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg?.t === 'register') {
          const info = bridge.register(ws, msg);
          ws.send(JSON.stringify({ t: 'registered', id: info.id, port: server.port, version: HOST_VERSION }));
          console.log(`connector #${info.id} registered (pid ${info.pid ?? '?'}, profile ${info.userDataDir ?? 'unknown'})`);
        } else if (msg?.t === 'ext') {
          const m = msg.msg;
          if (!m || typeof m !== 'object') return;
          if (!handleAgentMessage(ws, m)) bridge.onExtensionMessage(m);
        }
      },
      close(ws: Bun.ServerWebSocket<unknown>) {
        bridge.unregister(ws);
        for (const [sessionId, sessionWs] of sessionConnectors) {
          if (sessionWs === ws) sessionConnectors.delete(sessionId);
        }
      },
    },
  } as const;

  try {
    server = Bun.serve({ ...serveOptions, port: requestedPort });
  } catch (e: any) {
    if (String(e?.message || e).includes('in use')) {
      console.error(`port ${requestedPort} is busy — falling back to a random port`);
      server = Bun.serve({ ...serveOptions, port: 0 });
    } else {
      throw e;
    }
  }

  apps.daemonOrigin = () => `http://127.0.0.1:${server.port}`;

  const record: DaemonRecord = {
    pid: process.pid,
    port: server.port!,
    workspace,
    version: HOST_VERSION,
    startedAt: Date.now(),
    token: daemonToken,
  };
  writeFileSync(DAEMON_RECORD_PATH, JSON.stringify(record, null, 2), { mode: 0o600 });
  // `mode` on writeFileSync only applies when the file is created; a stale
  // world-readable record from a prior version would keep its perms, so force
  // 0600 explicitly — the token must not be readable by other local users.
  try { chmodSync(DAEMON_RECORD_PATH, 0o600); } catch {}

  const cleanup = () => {
    try {
      const rec = readDaemonRecord();
      if (rec?.pid === process.pid) unlinkSync(DAEMON_RECORD_PATH);
    } catch {}
    try {
      const lockPid = Number(readFileSync(DAEMON_LOCK_PATH, 'utf8').trim() || 0);
      if (lockPid === process.pid) unlinkSync(DAEMON_LOCK_PATH);
    } catch {}
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => process.exit(0));
  }

  console.log(`airglow daemon v${HOST_VERSION} on http://127.0.0.1:${server.port}`);
  console.log(`workspace: ${workspace}`);
  console.log(`log: ${DAEMON_LOG_PATH}`);

  const manifests = await apps.scanManifests();
  if (manifests.length === 0) {
    console.log('no apps found in the workspace yet');
  } else {
    console.log(`serving ${manifests.length} app(s): ${manifests.map((m) => m.id).join(', ')}`);
    const withMissing = apps.envStatus(manifests)
      .map((a) => ({ ...a, keys: a.keys.filter((k) => !k.set) }))
      .filter((a) => a.keys.length > 0);
    if (withMissing.length > 0) {
      console.log('missing env vars (declared in manifest.server_env):');
      for (const a of withMissing) {
        for (const k of a.keys) {
          console.log(`  ${a.appId}: ${k.key}${k.label ? ` — ${k.label}` : ''}`);
        }
      }
    }
  }
}
