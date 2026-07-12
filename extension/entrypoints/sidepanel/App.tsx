// ╔══════════════════════════════════════════════════════════════════════╗
// ║ DEPRECATED — the sidepanel agent chat is retired (2026-07-11).        ║
// ║ Do NOT build new features on this surface, route users to it, or add  ║
// ║ integrations that open/seed it. Users work with external agents       ║
// ║ (Claude Code etc.) in the workspace instead.                          ║
// ║ Code is kept for reference only; deletion is deliberate future work.  ║
// ╚══════════════════════════════════════════════════════════════════════╝
//
// Airglow sidepanel — the agent chat. Talks to the background over a Port
// named 'airglow-agent'; the background relays to the daemon over native
// messaging.
//
// Layout ideas borrowed from the Codex app: labeled message cards, live tool
// rows that collapse into a "Worked for Xs" expander when the turn finishes
// (leaving only the final answer), a "Thinking…" placeholder, an artifact
// card for the built app, and a composer whose send button becomes a stop
// button while the agent runs.

import { type ComponentType, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  ArrowUp, Bot, Camera, ChevronDown, ChevronRight, CircleAlert, ExternalLink, FileText,
  FilePen, FilePlus2, Globe, HelpCircle, History, Hourglass, Image as ImageIcon, KeyRound,
  LayoutGrid, MessageSquare, Plus, ScrollText, Search, Square, SquareTerminal, Wand2, Workflow, X,
} from 'lucide-react';
import { Markdown } from './markdown';
import { PinnedPlan, type PlanItem } from './strips';
import { FeedbackModal } from '../../components/FeedbackModal';
import { AnnouncementBanner } from '../../components/AnnouncementBanner';
import { SetupBanners, type SetupStep } from '../../components/SetupBanners';
import { useExtUpdateAvailable, applyExtUpdate } from '../../lib/ext-update';
import { SignInOverlay } from '../../components/SignInOverlay';
import { AUTH_SESSION_KEY } from '../../lib/airglow-auth';
import { UserScriptsOverlay } from '../../components/UserScriptsOverlay';
import { WindowsUnsupportedBanner } from '../../components/WindowsUnsupportedBanner';

const GITHUB_REPO_URL = 'https://github.com/airglow-inc/airglow-sdk';

// ── Types mirrored from host/src/agent/types.ts ──

type AgentEvent =
  | { type: 'session_started'; sessionId: string; title: string | null }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking' }
  | { type: 'tool_start'; toolId: string; name: string; input: Record<string, any> }
  | { type: 'tool_end'; toolId: string; name: string; ok: boolean; summary: string }
  | { type: 'plan'; items: PlanItem[] }
  | { type: 'task'; title: string }
  | { type: 'app_context'; appId: string; name: string }
  | { type: 'turn_done'; stopReason: string; startedAt?: number | null }
  | { type: 'user_message'; text: string; imageCount?: number; clientId?: string }
  | { type: 'followup_injected'; clientIds: string[] }
  // A transient connection drop is being retried (network, upstream 5xx, or a
  // stalled stream). Drives the "Reconnecting…" status until the stream resumes;
  // a retry that ultimately fails arrives as a normal `error` + turn_done.
  | { type: 'reconnecting'; attempt: number }
  | { type: 'error'; message: string; code?: string; resetHours?: number };

interface SessionMeta {
  id: string;
  title: string | null;
  appId: string | null;
  appName: string | null;
  updatedAt: number;
}

type ToolItem = { kind: 'tool'; toolId: string; name: string; input: Record<string, any>; status: 'running' | 'ok' | 'error'; summary: string };

// User images are data URLs; null = stripped in transport (history reload),
// rendered as a placeholder chip.
type ChatItem =
  // `queued` (with the optimistic-send `clientId`) marks a follow-up that's been
  // sent but not yet folded into the running turn — renders an "in queue" pill
  // until a followup_injected event for that clientId arrives.
  | { kind: 'user'; text: string; images?: (string | null)[]; clientId?: string; queued?: boolean }
  | { kind: 'text'; text: string }
  | ToolItem
  | { kind: 'work'; seconds: number; children: ChatItem[] }
  | { kind: 'appcard'; appId: string; name: string }
  | { kind: 'error'; text: string; code?: string; resetHours?: number };

type PendingImage = { mediaType: string; dataUrl: string; thumb: string };

// An app whose userscript matches the active tab's page. `enabled` = its
// userscripts are registered with Chrome, i.e. actually injected. `visible` =
// the app has visible DOM in the page (per the data-airglow-app stamps the
// SDK adds); null = the page couldn't be probed. `error` = the daemon
// reports an unset secret this app depends on.
type PageApp = { id: string; name: string; enabled: boolean; visible: boolean | null; error: boolean };

const CURRENT_SESSION_KEY = '__airglow_sidepanel_session';
const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:3222';

// Same pattern→regex conversion the background uses when deciding which tabs
// to reload after userscript registration (app-loader.ts).
function urlMatchesPattern(url: string, pattern: string): boolean {
  if (pattern === '<all_urls>') return /^(https?|file|ftp):/.test(url);
  try {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(url);
  } catch {
    return false;
  }
}

// ── Tool row presentation ──

function basename(p: string): string {
  return p.split('/').pop() || p;
}

function fmtDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.max(0, Math.round(seconds % 60));
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

// ── Attached-image thumbnails ───────────────────────────────────────────────
// Native messaging caps daemon→panel messages at 1MB, so the daemon strips
// base64 image bytes from the transcript it sends back (session.ts
// stripImagesForTransport). Without help, a reopened panel or a mid-turn resync
// would replace the user's attachment with a placeholder chip. We keep a small
// downscaled thumbnail of each attached image, keyed by its position in the
// session's image stream, and re-attach it when rebuilding from history. The
// store is capped per session; over budget, the oldest thumbnails drop to a chip.
const THUMB_KEY = (sid: string) => `__airglow_thumbs_${sid}`;
const THUMB_BUDGET = 5_000_000; // ~5MB of thumbnail data per session

// Downscale a data URL to a small JPEG preview (max edge `max`px). Falls back to
// the original on any canvas/decoding error.
function makeThumb(dataUrl: string, max = 256): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(dataUrl); return; }
      ctx.drawImage(img, 0, 0, w, h);
      try { resolve(canvas.toDataURL('image/jpeg', 0.7)); }
      catch { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function loadThumbs(sid: string | null): Record<number, string> {
  if (!sid) return {};
  try { return JSON.parse(localStorage.getItem(THUMB_KEY(sid)) || '{}'); }
  catch { return {}; }
}

function saveThumbs(sid: string | null, map: Record<number, string>): void {
  if (!sid) return;
  // Enforce the per-session budget: evict the lowest indices first. A miss on
  // reload simply renders that image as a chip again.
  let total = 0;
  for (const k of Object.keys(map)) total += map[+k]?.length ?? 0;
  if (total > THUMB_BUDGET) {
    for (const id of Object.keys(map).map(Number).sort((a, b) => a - b)) {
      if (total <= THUMB_BUDGET) break;
      total -= map[id]?.length ?? 0;
      delete map[id];
    }
  }
  try { localStorage.setItem(THUMB_KEY(sid), JSON.stringify(map)); } catch {}
}

// Count top-level user image blocks (attachments) across messages — used to
// keep the running thumbnail index aligned with the persisted transcript.
function countAttachedImages(messages: any[]): number {
  let n = 0;
  for (const msg of messages ?? []) {
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) if (b?.type === 'image') n++;
  }
  return n;
}

// Cap displayed tool output, noting how much was cut. Mirrors the daemon's
// tool_end summary cap (session.ts) so live and reconstructed turns match.
const SUMMARY_CHARS = 5000;
function truncateWithNote(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…(truncated, ${text.length - max} more chars)`;
}

function toolPresentation(name: string, input: Record<string, any>, summary: string, daemonOrigin: string, running = false): {
  Icon: typeof FileText;
  label: string;
  detail: string;
  imageUrl?: string;
} {
  const detailInput = name === 'bash' ? String(input.command ?? '') : JSON.stringify(input, null, 2);
  const detail = `${detailInput}\n\n${summary}`.trim();

  if (name === 'web_search') {
    const q = String(input.query ?? '');
    return { Icon: Globe, label: `${running ? 'Searching' : 'Searched'} the web for ${q}`.slice(0, 90), detail };
  }
  if (name === 'read') return { Icon: FileText, label: `Read ${basename(String(input.path ?? ''))}`, detail };
  if (name === 'write') return { Icon: FilePlus2, label: `Wrote ${basename(String(input.path ?? ''))}`, detail };
  if (name === 'edit') return { Icon: FilePen, label: `Edited ${basename(String(input.path ?? ''))}`, detail };
  if (name === 'glob' || name === 'grep') return { Icon: Search, label: `Searched ${String(input.pattern ?? '')}`.slice(0, 60), detail };

  if (name === 'bash') {
    const cmd = String(input.command ?? '');
    // The model's stated intent (bash `description` arg) is the user-facing
    // label when present; the command-shape fallbacks below fill the icon and
    // the label for older turns that predate the field.
    const intent = typeof input.description === 'string' ? input.description.trim() : '';
    // A screenshot path anywhere in the output (shot is often part of a
    // compound command) → render the image inline.
    const shot = detail.match(/shots\/([A-Za-z0-9_.-]+\.(?:jpe?g|png|webp))/);
    const imageUrl = shot ? `${daemonOrigin}/api/shots/${shot[1]}` : undefined;
    let Icon: typeof FileText = SquareTerminal;
    let label = `Ran ${cmd.slice(0, 60) || 'a command'}`;
    const fetchCmd = cmd.match(/airglow\s+fetch\s+(\S+)/);
    const browser = cmd.match(/airglow\s+browser\s+(\w+)\s*(.*)/);
    if (fetchCmd) {
      Icon = Globe;
      label = `${running ? 'Fetching' : 'Fetched'} ${fetchCmd[1]}`;
    } else if (browser) {
      const [, sub, rest] = browser;
      const bySub: Record<string, { Icon: typeof FileText; label: string }> = {
        open: { Icon: Globe, label: `Opened ${(rest.match(/https?:\/\/\S+/) || ['page'])[0]}` },
        nav: { Icon: Globe, label: 'Navigated tab' },
        eval: { Icon: SquareTerminal, label: 'Ran JS in the page' },
        html: { Icon: FileText, label: 'Read page HTML' },
        logs: { Icon: ScrollText, label: 'Checked browser logs' },
        tabs: { Icon: Globe, label: 'Listed open tabs' },
        close: { Icon: Globe, label: 'Closed a tab' },
        shot: { Icon: Camera, label: 'Took a screenshot' },
      };
      const m = bySub[sub];
      if (m) { Icon = m.Icon; label = m.label; }
    }
    return { Icon, label: (intent || label).slice(0, 90), detail, imageUrl };
  }

  return { Icon: SquareTerminal, label: name, detail };
}

// A labeled code block inside an expanded tool row.
function ToolField({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-1.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide mb-0.5 px-0.5" style={{ color: 'var(--fg-tertiary)' }}>{label}</div>
      <pre
        className="p-2.5 rounded-sm text-[12px] overflow-x-auto whitespace-pre-wrap break-words thin-scroll"
        style={{ background: 'var(--gray-150)', border: '1px solid var(--border-tertiary)', color: 'var(--fg-secondary)', fontFamily: 'var(--font-mono)', maxHeight: 240, overflowY: 'auto' }}
      >{truncateWithNote(value, SUMMARY_CHARS + 100)}</pre>
    </div>
  );
}

function ToolRow({ item, daemonOrigin }: { item: ToolItem; daemonOrigin: string }) {
  const [open, setOpen] = useState(false);
  const { Icon, label, imageUrl } = toolPresentation(item.name, item.input, item.summary, daemonOrigin, item.status === 'running');
  const color = item.status === 'error' ? 'var(--error)' : 'var(--fg-tertiary)';
  // Input: the command for bash, the arguments otherwise. Output: the result.
  const inputText = item.name === 'bash' ? String(item.input.command ?? '') : JSON.stringify(item.input, null, 2);
  const outputText = item.summary.trim();
  return (
    <div className="my-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full text-left cursor-pointer rounded-sm px-1 py-0.5"
        style={{ color, background: 'transparent', border: 0 }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <Icon size={14} className="shrink-0" />
        <span className="truncate text-[13px]">{label}</span>
        {item.status === 'running' && <span className="working-dot ml-1 inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--clay)' }} />}
        {item.status === 'error' && <CircleAlert size={13} className="shrink-0" />}
        {open ? <ChevronDown size={13} className="ml-auto shrink-0" /> : <ChevronRight size={13} className="ml-auto shrink-0" />}
      </button>
      {open && (
        <div className="ml-5">
          {inputText && <ToolField label="Input" value={inputText} />}
          {outputText && <ToolField label={item.status === 'error' ? 'Error' : 'Output'} value={outputText} />}
          {!inputText && !outputText && <div className="mt-1 text-[12px]" style={{ color: 'var(--fg-tertiary)' }}>No details.</div>}
        </div>
      )}
      {imageUrl && (
        <img
          src={imageUrl}
          alt="screenshot"
          className="mt-1.5 ml-5 rounded-md border max-w-full"
          style={{ borderColor: 'var(--border-secondary)', maxHeight: 240 }}
        />
      )}
    </div>
  );
}

// Activity items (tool rows + narration + errors) — shared by the finished
// "Worked" group and the live expander.
function ActivityList({ children, daemonOrigin }: { children: ChatItem[]; daemonOrigin: string }) {
  return (
    <>
      {children.map((child, i) => {
        if (child.kind === 'tool') return <ToolRow key={child.toolId} item={child} daemonOrigin={daemonOrigin} />;
        if (child.kind === 'text') {
          return (
            <div key={i} className="my-2.5 text-[15px] leading-relaxed" style={{ color: 'var(--fg-primary)' }}>
              <Markdown text={child.text} />
            </div>
          );
        }
        if (child.kind === 'error') {
          return (
            <div key={i} className="my-1 text-[12.5px] flex items-start gap-1.5" style={{ color: 'var(--error)' }}>
              <CircleAlert size={13} className="shrink-0 mt-0.5" />
              <span className="break-words min-w-0">{child.text}</span>
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

// "Worked for 4m 13s ›" — the collapsed record of everything the agent did
// during a finished turn (tool calls + intermediate narration).
function WorkGroup({ item, daemonOrigin }: { item: Extract<ChatItem, { kind: 'work' }>; daemonOrigin: string }) {
  const [open, setOpen] = useState(false);
  // seconds = 0 means "reconstructed from history, duration unknown" → plain "Worked".
  const label = item.seconds > 0
    ? `Worked for ${fmtDuration(item.seconds)}`
    : 'Worked';
  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 cursor-pointer text-[13px] px-1 py-0.5 rounded-sm"
        style={{ color: 'var(--fg-tertiary)', background: 'transparent', border: 0 }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg-secondary)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-tertiary)'; }}
        data-testid="work-group-toggle"
      >
        {label}
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="mt-1">
          <ActivityList daemonOrigin={daemonOrigin}>{item.children}</ActivityList>
        </div>
      )}
    </div>
  );
}

function AppCard({ appId, name }: { appId: string; name: string }) {
  return (
    <div className="my-2 p-3 rounded-xl border flex items-start gap-3" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-tertiary)' }} data-testid="app-card">
      <div
        className="w-9 h-9 rounded-lg inline-flex items-center justify-center shrink-0"
        style={{ background: 'color-mix(in srgb, var(--clay) 14%, transparent)', color: 'var(--clay-interactive)' }}
      >
        <LayoutGrid size={18} />
      </div>
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold truncate" style={{ color: 'var(--fg-primary)' }}>{name}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?app=${appId}`) })}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-medium cursor-pointer border shrink-0"
            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-secondary)', color: 'var(--fg-primary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
          >
            <ExternalLink size={13} />
            Open settings
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main app ──

// Env keys declared by installed apps (manifest.server_env) that nothing
// provides yet, grouped per app. Only apps active on the current tab are
// shown — keys for apps that aren't running here aren't actionable. The
// daemon reports set-ness only — values are written via /api/env/set into
// the daemon's per-app UI store and never read back. Refreshes when a turn
// ends, so a key required by an app the agent just built surfaces
// immediately.
type AppEnvKey = { key: string; label?: string; set: boolean };
type AppEnvStatus = { appId: string; name: string; keys: AppEnvKey[] };

function MissingKeysCard({ daemonOrigin, running, activeAppIds }: { daemonOrigin: string; running: boolean; activeAppIds: string[] }) {
  const [apps, setApps] = useState<AppEnvStatus[]>([]);
  // Keyed by `${appId}:${key}` — two apps may declare the same key name.
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(true);
  const [hover, setHover] = useState(false);
  // Stable dep — pageApps recomputes on every tab event, ids rarely change.
  const idsKey = activeAppIds.slice().sort().join(',');

  function onlyMissing(all: AppEnvStatus[]): AppEnvStatus[] {
    return all
      .filter((a) => activeAppIds.includes(a.appId))
      .map((a) => ({ ...a, keys: a.keys.filter((k) => !k.set) }))
      .filter((a) => a.keys.length > 0);
  }

  useEffect(() => {
    if (running) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${daemonOrigin}/api/env/status`);
        const data = await res.json();
        if (alive && Array.isArray(data?.apps)) setApps(onlyMissing(data.apps));
      } catch {
        // daemon unreachable — the host-offline card covers that state
        if (alive) setApps([]);
      }
    })();
    return () => { alive = false; };
  }, [daemonOrigin, running, idsKey]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      let latest: AppEnvStatus[] | null = null;
      for (const a of apps) {
        const entries: Record<string, string> = {};
        for (const k of a.keys) {
          const v = (inputs[`${a.appId}:${k.key}`] || '').trim();
          if (v) entries[k.key] = v;
        }
        if (Object.keys(entries).length === 0) continue;
        const res = await fetch(`${daemonOrigin}/api/env/set`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: a.appId, entries }),
        });
        const data = await res.json();
        if (Array.isArray(data?.apps)) latest = data.apps;
      }
      if (latest) {
        setApps(onlyMissing(latest));
        setInputs({});
      }
    } catch {}
    setSaving(false);
  }

  if (apps.length === 0) return null;
  const totalKeys = apps.reduce((n, a) => n + a.keys.length, 0);
  const hasInput = apps.some((a) => a.keys.some((k) => (inputs[`${a.appId}:${k.key}`] || '').trim()));
  return (
    <div
      className="m-3 mb-0 p-3.5 border rounded-lg shrink-0"
      style={{ background: 'color-mix(in srgb, var(--clay) 6%, var(--bg-white))', borderColor: 'color-mix(in srgb, var(--clay) 30%, var(--border-tertiary))' }}
      data-testid="missing-keys-card"
    >
      <button
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="w-full flex items-center gap-1.5 text-[13px] font-semibold cursor-pointer rounded-md px-1.5 py-1 -mx-1.5 -my-1"
        style={{
          color: 'var(--fg-primary)',
          background: hover ? 'color-mix(in srgb, var(--clay) 12%, transparent)' : 'transparent',
        }}
        aria-expanded={open}
        data-testid="missing-keys-toggle"
      >
        <KeyRound size={14} />
        {totalKeys === 1 ? `${apps[0].name} needs an API key` : 'Apps need API keys'}
        <span className="ml-auto" style={{ color: 'var(--fg-secondary)' }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {open && (<>
      <div className="flex flex-col gap-2 mt-3">
        {apps.map((a) => (
          <div
            key={a.appId}
            className="rounded-lg border p-3"
            style={{
              background: 'color-mix(in srgb, var(--sky) 8%, var(--bg-white))',
              borderColor: 'color-mix(in srgb, var(--sky) 30%, var(--border-tertiary))',
            }}
            data-testid={`missing-keys-app-${a.appId}`}
          >
            {!(totalKeys === 1) && (
              <div className="text-[13px] font-semibold mb-2" style={{ color: 'var(--fg-primary)' }}>{a.name}</div>
            )}
            <div className="flex flex-col gap-2">
              {a.keys.map((k) => (
                <div key={k.key}>
                  <div className="text-[12px] mb-1" style={{ color: 'var(--fg-secondary)' }}>
                    {k.label || k.key}
                  </div>
                  <input
                    type="password"
                    value={inputs[`${a.appId}:${k.key}`] || ''}
                    onChange={(e) => setInputs((prev) => ({ ...prev, [`${a.appId}:${k.key}`]: e.target.value }))}
                    placeholder={k.key}
                    className="w-full h-8 px-2.5 text-[13px] rounded-md border outline-none"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-white)', color: 'var(--fg-primary)', fontFamily: 'var(--font-mono)' }}
                    data-testid={`missing-key-input-${a.appId}:${k.key}`}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => void save()}
        disabled={!hasInput || saving}
        className="mt-2.5 h-8 px-3.5 rounded-md text-[13px] font-medium border"
        style={{
          color: 'var(--bg-white)',
          background: 'var(--clay)',
          borderColor: 'var(--clay)',
          opacity: hasInput && !saving ? 1 : 0.4,
          cursor: hasInput && !saving ? 'pointer' : 'not-allowed',
        }}
        data-testid="missing-keys-save"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      </>)}
    </div>
  );
}

export default function App() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(CURRENT_SESSION_KEY));
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState(false);
  // The model connection dropped and is being retried. Shows a "Reconnecting…"
  // status (distinct from "Thinking") so a stalled turn reads as a problem being
  // worked on, not silent progress. Cleared the moment the stream resumes (next
  // text/tool/thinking event) or the turn ends.
  const [reconnecting, setReconnecting] = useState(false);
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [task, setTask] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  // Expanded state of the live activity peek (the chevron on the status line).
  const [liveOpen, setLiveOpen] = useState(false);
  const [hostConnected, setHostConnected] = useState<boolean | null>(null);
  // Windows has no native host (macOS/Linux only) — gates the unsupported view.
  const [isWindows, setIsWindows] = useState(false);
  const [daemonOrigin, setDaemonOrigin] = useState(DEFAULT_DAEMON_ORIGIN);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [pageApps, setPageApps] = useState<PageApp[]>([]);
  // The page-apps dropdown opens on hover; the grace timer keeps it open
  // while the pointer crosses from the trigger into the card.
  const [appsOpen, setAppsOpen] = useState(false);
  const appsHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // The active inline setup banner ('host' | 'pin' | null), reported by
  // SetupBanners. While the pin banner is up we hide the panel's working
  // surface so the user finishes pinning before doing anything else.
  const [setupStep, setSetupStep] = useState<SetupStep | null>(null);
  // Staged extension update (null when up to date) → the version + Update button
  // in the composer footer.
  const extUpdate = useExtUpdateAvailable();


  const portRef = useRef<chrome.runtime.Port | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Mirror of `running` for closures (reconcile, listeners) that need the
  // latest value without re-subscribing.
  const runningRef = useRef(running);
  runningRef.current = running;
  // Timestamp of the last agent event received from the daemon. A running turn
  // emits events steadily; a long silence means the live stream dropped events
  // between daemon and panel (the background relay has no buffer) — the
  // watchdog uses this to trigger a history reconcile.
  const lastEventAtRef = useRef(0);
  // Highest live-event seq applied (the daemon stamps each agent event with a
  // per-session monotonic seq). Lets a resync replay the buffered turn while
  // the live stream dedups anything already applied. Reset on a new chat.
  const lastSeqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingReplies = useRef(new Map<string, (msg: any) => void>());
  const nextReqId = useRef(1);
  // clientIds of follow-ups this panel already rendered optimistically. The
  // daemon echoes each follow-up back as a user_message event (so other panels
  // and a resync see it); the originating panel skips its own to avoid a dup.
  const echoedFollowupIds = useRef(new Set<string>());
  // Where the current turn's items start, and when the turn began — used to
  // collapse the turn's activity into a WorkGroup on turn_done.
  const turnStartRef = useRef<{ index: number; startedAt: number } | null>(null);
  // App context announced during the current turn → render an app card after.
  const turnAppRef = useRef<{ id: string; name: string } | null>(null);
  // Downscaled previews of the user's attached images, keyed by their running
  // index in this session's image stream, plus the next index to assign. Lets a
  // history rebuild (the daemon strips image bytes) re-attach a thumbnail
  // instead of a placeholder chip. See the thumbnail helpers above.
  const thumbsRef = useRef<Record<number, string>>({});
  const imageCountRef = useRef(0);
  // The last turn we submitted (text + images), and — when it failed with
  // AUTH_SESSION_INVALID — the turn to auto-resend once the user re-signs-in.
  const lastTurnRef = useRef<{ text: string; images: PendingImage[] } | null>(null);
  const pendingAuthRetryRef = useRef<{ text: string; images: PendingImage[] } | null>(null);
  // Holds the latest submitTurn closure so the auth-session listener (below,
  // mounted once) always calls the current one rather than a stale capture.
  const submitTurnRef = useRef<(text: string, images: PendingImage[], opts?: { echo?: boolean }) => void>(() => {});
  // The window this sidepanel is docked to — sent with agent:start so the
  // agent's `airglow browser tabs` can mark this window's active tab as
  // `current` (each window has its own sidepanel instance).
  const windowIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    chrome.windows.getCurrent().then((w) => { windowIdRef.current = w.id; }).catch(() => {});
  }, []);

  // Auto-resend a turn that failed with AUTH_SESSION_INVALID once a fresh
  // session lands (user signed back in via the overlay). The background pushes
  // the new token to the daemon on this same storage change; the short delay
  // lets it arrive before the resent turn reaches the gateway.
  useEffect(() => {
    const onChange = (c: Record<string, chrome.storage.StorageChange>) => {
      if (!(AUTH_SESSION_KEY in c)) return;
      const next = c[AUTH_SESSION_KEY].newValue as { token?: unknown; expiresAt?: unknown } | undefined;
      const valid = !!next && typeof next.token === 'string' && next.token.length > 0
        && typeof next.expiresAt === 'number' && next.expiresAt > Date.now();
      const turn = pendingAuthRetryRef.current;
      if (valid && turn && !runningRef.current) {
        pendingAuthRetryRef.current = null;
        setTimeout(() => submitTurnRef.current(turn.text, turn.images, { echo: false }), 500);
      }
    };
    chrome.storage?.local?.onChanged.addListener(onChange);
    return () => chrome.storage?.local?.onChanged.removeListener(onChange);
  }, []);
  // Auto-focus the composer when the sidepanel opens (and once the host
  // becomes available, since the textarea is disabled while disconnected).
  useEffect(() => {
    if (hostConnected !== false) inputRef.current?.focus();
  }, [hostConnected]);

  // Detect Windows once on mount — the native host can't run there.
  useEffect(() => {
    chrome.runtime.getPlatformInfo((info) => setIsWindows(info.os === 'win'));
  }, []);

  // Analytics: panel opened. Routed through the background (where the PostHog
  // identify gate is released) like dashboard_opened. Fires once per mount.
  useEffect(() => {
    chrome.runtime.sendMessage(
      { type: 'airglow:track-sidepanel-opened' },
      () => { void chrome.runtime.lastError; },
    );
  }, []);


  function post(msg: Record<string, unknown>): void {
    try { portRef.current?.postMessage(msg); } catch {}
  }

  function request(msg: Record<string, unknown>): Promise<any> {
    const reqId = `r${nextReqId.current++}`;
    return new Promise((resolve) => {
      pendingReplies.current.set(reqId, resolve);
      post({ ...msg, reqId });
      setTimeout(() => {
        if (pendingReplies.current.delete(reqId)) resolve(null);
      }, 8000);
    });
  }

  // Collapse the finished turn: everything between turn start and the last
  // text item becomes a WorkGroup; the last text item stays visible as the
  // final answer. Plan items stay visible too.
  function collapseTurn(prev: ChatItem[], startedAtOverride?: number | null): ChatItem[] {
    // Turn start is normally tracked in turnStartRef, but a SW recycle or a
    // resumed turn can lose it — fall back to the last user message so the
    // turn still collapses instead of rendering fully expanded.
    let startIndex = turnStartRef.current?.index;
    if (startIndex === undefined) {
      startIndex = prev.length;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].kind === 'user') { startIndex = i + 1; break; }
      }
    }
    // Prefer the daemon's authoritative turn start (from turn_done) — it
    // survives a panel that lost its own ref mid-turn (reopen/resync); the
    // local ref is the fallback for an older daemon that omits it.
    const startedAt = (typeof startedAtOverride === 'number' && startedAtOverride > 0)
      ? startedAtOverride
      : (turnStartRef.current?.startedAt ?? 0);
    const turn = { index: startIndex, startedAt };
    const slice = prev.slice(turn.index);
    let lastTextIdx = -1;
    for (let i = slice.length - 1; i >= 0; i--) {
      if (slice[i].kind === 'text') { lastTextIdx = i; break; }
    }
    const collapsible: ChatItem[] = [];
    const keep: ChatItem[] = [];
    slice.forEach((it, i) => {
      const isFinalText = i === lastTextIdx;
      // Errors stay visible (like plan/appcard) — never hidden inside
      // the steps group, so a failed turn surfaces its reason.
      if (!isFinalText && (it.kind === 'tool' || it.kind === 'text')) collapsible.push(it);
      else keep.push(it);
    });
    const result = prev.slice(0, turn.index);
    if (collapsible.length > 0) {
      // startedAt 0 → duration unknown (recovered turn); WorkGroup shows plain "Worked".
      const seconds = turn.startedAt ? (Date.now() - turn.startedAt) / 1000 : 0;
      result.push({ kind: 'work', seconds, children: collapsible });
    }
    // Final answer (and plan) goes after the work group.
    result.push(...keep);
    const app = turnAppRef.current;
    if (app) result.push({ kind: 'appcard', appId: app.id, name: app.name });
    return result;
  }

  // Re-sync run-state with the daemon. A daemon restart kills the in-flight
  // turn, but the sidepanel never hears about it — the service-worker port to
  // the panel stays up, only the host↔daemon socket drops — so `running` can
  // stick true forever (endless "Working…" spinner). The backend is the source
  // of truth: if it reports no live turn, clear the spinner and fold the
  // orphaned turn into a "Worked" group. Triggered on daemon (re)connect and
  // when the panel becomes visible again.
  async function reconcileRunning(resync = false): Promise<void> {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const res = await request({ type: 'agent:history', sessionId: sid });
    if (!res) return; // daemon unreachable — leave state as-is, retry next signal
    // The history request itself re-pins the daemon→panel event route (so a
    // connector/SW recycle stops orphaning the live stream). On an explicit
    // resync (silence watchdog, reconnect) also rebuild + replay the live turn
    // from the daemon's event buffer, recovering anything missed during the gap.
    if (res.running) {
      if (resync) applyHistory(res);
      else setRunning(true);
      return;
    }
    if (!runningRef.current) return; // already idle — nothing to reconcile
    // The backend turn is over but the panel still shows it running — we missed
    // the tail of the live stream. Rebuild from persisted history (the source of
    // truth) so a missed answer is recovered, not just the spinner cleared.
    // Falls back to collapsing the live items if history is unavailable.
    if (Array.isArray(res.messages) && res.messages.length > 0) {
      applyHistory(res);
    } else {
      setItems((prev) => collapseTurn(prev));
      setRunning(false);
      setThinking(false);
      setReconnecting(false);
      turnStartRef.current = null;
      turnAppRef.current = null;
    }
  }

  function applyEvent(ev: AgentEvent): void {
    switch (ev.type) {
      case 'session_started':
        setSessionId(ev.sessionId);
        localStorage.setItem(CURRENT_SESSION_KEY, ev.sessionId);
        // The first turn recorded its thumbnails before the id existed — persist
        // them now under the assigned session id.
        saveThumbs(ev.sessionId, thumbsRef.current);
        setRunning(true);
        break;
      case 'thinking':
        // The stream resumed — a new model step opened a thinking block.
        setReconnecting(false);
        setThinking(true);
        break;
      case 'reconnecting':
        // A transient drop is being retried; keep the spinner but relabel it.
        setReconnecting(true);
        break;
      case 'text_delta':
        setReconnecting(false);
        setThinking(false);
        setItems((prev) => {
          const last = prev[prev.length - 1];
          if (last?.kind === 'text') {
            return [...prev.slice(0, -1), { kind: 'text', text: last.text + ev.text }];
          }
          return [...prev, { kind: 'text', text: ev.text }];
        });
        break;
      case 'tool_start':
        setReconnecting(false);
        setThinking(false);
        if (ev.name === 'plan' || ev.name === 'task') break; // rendered via the plan/task strips
        setItems((prev) => [...prev, { kind: 'tool', toolId: ev.toolId, name: ev.name, input: ev.input, status: 'running', summary: '' }]);
        break;
      case 'tool_end':
        setItems((prev) => prev.map((it) =>
          it.kind === 'tool' && it.toolId === ev.toolId
            ? { ...it, status: ev.ok ? 'ok' : 'error', summary: ev.summary }
            : it,
        ));
        break;
      case 'plan':
        setPlan(ev.items);
        break;
      case 'task':
        setTask(ev.title);
        break;
      case 'app_context':
        turnAppRef.current = { id: ev.appId, name: ev.name };
        break;
      case 'turn_done': {
        // Clear any lingering "in queue" pill: a turn only ends once its queue
        // is drained, and a stopped/aborted turn won't inject what's left.
        setItems((prev) => collapseTurn(prev, ev.startedAt).map((it) =>
          it.kind === 'user' && it.queued ? { ...it, queued: false } : it));
        turnStartRef.current = null;
        turnAppRef.current = null;
        setRunning(false);
        setThinking(false);
        setReconnecting(false);
        setLiveOpen(false);
        break;
      }
      case 'user_message':
        // Our own follow-up coming back — already shown optimistically; skip.
        if (ev.clientId && echoedFollowupIds.current.has(ev.clientId)) {
          echoedFollowupIds.current.delete(ev.clientId);
          break;
        }
        setThinking(false);
        setItems((prev) => [...prev, {
          kind: 'user',
          text: ev.text,
          // No bytes in transport — render attachments as placeholder chips.
          images: ev.imageCount ? Array(ev.imageCount).fill(null) : undefined,
          // A user_message is always a follow-up still waiting in the queue at
          // emit time (other panels / resync replay) — show the pill until the
          // matching followup_injected lands.
          clientId: ev.clientId,
          queued: true,
        }]);
        break;
      case 'followup_injected':
        setItems((prev) => prev.map((it) =>
          it.kind === 'user' && it.queued && it.clientId && ev.clientIds.includes(it.clientId)
            ? { ...it, queued: false }
            : it,
        ));
        break;
      case 'error':
        setThinking(false);
        setReconnecting(false);
        // A rejected session token: the background drops it → SignInOverlay
        // appears. Stash this turn and skip the error bubble — it auto-resends
        // once the user signs back in (see the AUTH_SESSION_KEY listener), so
        // the message goes through instead of dead-ending on a red error.
        if (ev.code === 'AUTH_SESSION_INVALID' && lastTurnRef.current) {
          pendingAuthRetryRef.current = lastTurnRef.current;
          break;
        }
        setItems((prev) => [...prev, { kind: 'error', text: ev.message, code: ev.code, resetHours: ev.resetHours }]);
        break;
    }
  }

  // Rebuild the panel from a daemon history reply. A finished session is a
  // straight reconstruct. A live (running) turn rebuilds completed turns from
  // persisted history, then replays the daemon's live event buffer so the
  // in-flight turn renders exactly as it streamed — including events emitted
  // while the panel was closed (the relay has no buffer; the daemon does).
  // Idempotent: safe on mount, on reconnect, and from the silence watchdog.
  function applyHistory(res: any): void {
    if (!res || !Array.isArray(res.messages)) return;
    if (typeof res.lastSeq === 'number') lastSeqRef.current = res.lastSeq;
    // Restore the session's thumbnail store and re-sync the running image index
    // with the transcript, so reconstruct re-attaches previews and the next send
    // assigns the right index. (The daemon strips image bytes from transport.)
    const thumbs = loadThumbs(sessionIdRef.current);
    thumbsRef.current = thumbs;
    if (res.running) {
      const completedImgs = countAttachedImages(res.messages);
      const base = reconstructItems(res.messages, null, res.times, thumbs, 0);
      const turnUserMsgs = res.turnUserMessage ? [res.turnUserMessage] : [];
      const turnUser = turnUserMsgs.length ? reconstructItems(turnUserMsgs, null, undefined, thumbs, completedImgs).items : [];
      const baseItems = [...base.items, ...turnUser];
      imageCountRef.current = completedImgs + countAttachedImages(turnUserMsgs);
      setItems(baseItems);
      setPlan(base.plan);
      setTask(base.task);
      setThinking(false);
      setReconnecting(false);
      setRunning(true);
      turnStartRef.current = {
        index: baseItems.length,
        startedAt: typeof res.turnStartedAt === 'number' ? res.turnStartedAt : Date.now(),
      };
      turnAppRef.current = null;
      // Reset the watchdog clock so this fresh replay isn't immediately re-run.
      lastEventAtRef.current = Date.now();
      // Replay the buffered turn (these carry seq ≤ lastSeq; the live stream's
      // own dedup skips them, so apply directly here).
      for (const e of (Array.isArray(res.events) ? res.events : [])) {
        applyEvent(e.event as AgentEvent);
      }
    } else {
      imageCountRef.current = countAttachedImages(res.messages);
      const rec = reconstructItems(res.messages, res.meta, res.times, thumbs, 0);
      setItems(rec.items);
      setPlan(rec.plan);
      setTask(rec.task);
      setRunning(false);
      setThinking(false);
      setReconnecting(false);
      turnStartRef.current = null;
      turnAppRef.current = null;
    }
  }

  // Port connection (reconnect when the service worker recycles).
  useEffect(() => {
    let cancelled = false;
    function connect(): void {
      if (cancelled) return;
      const port = chrome.runtime.connect({ name: 'airglow-agent' });
      portRef.current = port;
      port.onMessage.addListener((msg: any) => {
        if (msg?.type === 'agent:event') {
          if (msg.sessionId && sessionIdRef.current && msg.sessionId !== sessionIdRef.current) return;
          // Drop events already applied via a resync replay (idempotent across
          // reconnects). Untagged events (older daemon) always apply.
          if (typeof msg.seq === 'number') {
            if (msg.seq <= lastSeqRef.current) return;
            lastSeqRef.current = msg.seq;
          }
          lastEventAtRef.current = Date.now();
          applyEvent(msg.event as AgentEvent);
        } else if (typeof msg?.reqId === 'string') {
          const resolve = pendingReplies.current.get(msg.reqId);
          if (resolve) {
            pendingReplies.current.delete(msg.reqId);
            resolve(msg);
          }
        }
      });
      port.onDisconnect.addListener(() => {
        if (portRef.current === port) portRef.current = null;
        setTimeout(() => {
          connect();
          // The panel port was down — any events the daemon emitted during the
          // gap were dropped (the relay has no buffer). If a turn was running,
          // resync against the daemon's event buffer once the new port is wired
          // so the missed tail (text / tools / turn_done) is recovered.
          if (runningRef.current) setTimeout(() => { void reconcileRunning(true); }, 400);
        }, 500);
      });
    }
    connect();
    return () => {
      cancelled = true;
      try { portRef.current?.disconnect(); } catch {}
    };
  }, []);

  // Host status + daemon origin from storage.
  useEffect(() => {
    chrome.storage.local.get(['__native_host_connected', '__daemon_origin'], (r) => {
      setHostConnected(r['__native_host_connected'] === undefined ? null : !!r['__native_host_connected']);
      if (typeof r['__daemon_origin'] === 'string') setDaemonOrigin(r['__daemon_origin']);
    });
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('__native_host_connected' in changes) {
        const connected = !!changes['__native_host_connected'].newValue;
        setHostConnected(connected);
        // Daemon (re)connected — give the connector handshake a moment, then
        // resync: clears a restart's stale spinner, and replays the live turn's
        // event buffer if it's still running (the daemon survived, the link
        // didn't).
        if (connected) setTimeout(() => { void reconcileRunning(true); }, 500);
      }
      if ('__daemon_origin' in changes && typeof changes['__daemon_origin'].newValue === 'string') {
        setDaemonOrigin(changes['__daemon_origin'].newValue);
      }
    };
    chrome.storage.local.onChanged.addListener(onChange);
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, []);

  // Re-sync run-state when the panel becomes visible again — covers a daemon
  // restart that happened while the sidepanel was hidden (no storage event
  // observed, or the connect signal landed before mount).
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void reconcileRunning(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Watchdog for a stuck live turn. A running turn emits events steadily; a
  // long silence means the live stream dropped the tail (SW suspend, port
  // reconnect, daemon native-messaging hiccup) — the relay has no buffer, so a
  // dropped text/turn_done leaves the answer missing and the spinner stuck.
  // The resync rebuilds + replays the daemon's event buffer to recover. Safe
  // during a genuinely busy turn: re-pins the route and re-renders the same
  // turn (a long bash/install legitimately emits nothing in between).
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      if (Date.now() - lastEventAtRef.current > 15_000) void reconcileRunning(true);
    }, 5_000);
    return () => clearInterval(t);
  }, [running]);

  // Apps injected into the active tab of this window. Recomputed on tab
  // switch, navigation, and app list / disabled-set changes.
  useEffect(() => {
    let alive = true;
    async function refresh(): Promise<void> {
      try {
        const win = await chrome.windows.getCurrent();
        const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
        const url = tab?.url ?? '';
        if (!url) {
          if (alive) setPageApps([]);
          return;
        }
        const stored = await chrome.storage.local.get(['__app_manifests', '__disabled_apps', '__daemon_origin']);
        const manifests = (stored['__app_manifests'] as any[] | undefined) ?? [];
        const disabled = new Set((stored['__disabled_apps'] as string[] | undefined) ?? []);
        const matched = manifests
          .filter((m) => m)
          .filter((m) => (m.userscripts ?? []).some((us: any) => (us.matches ?? []).some((p: string) => urlMatchesPattern(url, p))));
        // "Active" = the app's userscripts are actually registered with Chrome
        // (enabled toggle + source reachable), so they're injected into pages
        // they match. Fall back to the disabled set if the API isn't available
        // in this context.
        let registeredIds: Set<string> | null = null;
        try {
          const scripts = await (chrome as any).userScripts?.getScripts?.();
          if (Array.isArray(scripts)) {
            registeredIds = new Set(scripts.map((s: any) => String(s.id).split('__')[0]));
          }
        } catch {}
        const isActive = (id: string) => (registeredIds ? registeredIds.has(id) : !disabled.has(id));
        // Apps with an unset secret, per the daemon (same source the dashboard
        // uses for its "N secrets missing" badge). Daemon offline → no badges.
        const brokenIds = new Set<string>();
        if (matched.length > 0) {
          const origin = typeof stored['__daemon_origin'] === 'string' && stored['__daemon_origin']
            ? (stored['__daemon_origin'] as string)
            : DEFAULT_DAEMON_ORIGIN;
          try {
            const res = await fetch(`${origin}/api/env/status`, { signal: AbortSignal.timeout(3000) });
            const data = await res.json();
            if (Array.isArray(data?.apps)) {
              for (const a of data.apps) {
                if ((a?.keys ?? []).some((k: any) => !k?.set)) brokenIds.add(a.appId);
              }
            }
          } catch {}
        }
        // Which apps have visible DOM in the page right now? The SDK stamps
        // app-attached elements with data-airglow-app. Probe fails on pages
        // we can't script (chrome://, web store) → null, status falls back
        // to a plain "Active".
        let visibleIds: Set<string> | null = null;
        if (tab?.id != null && matched.length > 0) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const ids: string[] = [];
                document.querySelectorAll('[data-airglow-app]').forEach((el) => {
                  const id = el.getAttribute('data-airglow-app');
                  if (!id || ids.includes(id)) return;
                  const r = el.getBoundingClientRect();
                  const cs = getComputedStyle(el);
                  if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') ids.push(id);
                });
                return ids;
              },
            });
            visibleIds = new Set((results?.[0]?.result as string[] | undefined) ?? []);
          } catch {}
        }
        const apps: PageApp[] = matched
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            enabled: isActive(m.id),
            visible: isActive(m.id) ? (visibleIds ? visibleIds.has(m.id) : null) : false,
            error: isActive(m.id) && brokenIds.has(m.id),
          }))
          .sort((a, b) => Number(b.enabled) - Number(a.enabled));
        if (alive) setPageApps(apps);
      } catch {
        // window/tab gone mid-query — keep the previous list
      }
    }
    void refresh();
    const onActivated = () => void refresh();
    const onUpdated = (_id: number, info: { url?: string; status?: string }, tab: chrome.tabs.Tab) => {
      if (tab.active && (info.url || info.status === 'complete')) void refresh();
    };
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('__app_manifests' in changes || '__disabled_apps' in changes) void refresh();
    };
    // Apps mount their on-page UI asynchronously — after the SPA hydrates, well
    // past status:complete (e.g. Focus Hider waits for x.com's primaryColumn).
    // A one-shot probe at load time misses that UI and the status sticks on
    // "Hidden". Re-probe while the panel is visible to catch late injection and
    // client-side navigation that doesn't fire a full load.
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 4000);
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.storage.local.onChanged.addListener(onStorage);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(poll);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.storage.local.onChanged.removeListener(onStorage);
    };
  }, []);

  // Resume the last session on mount (reopening the panel remounts fresh).
  // applyHistory restores the full transcript and, if a turn is still running
  // in the daemon, replays its live event buffer with the true start time — so
  // the agent keeps going and the view comes back as it was, not from scratch.
  useEffect(() => {
    if (!sessionId) return;
    void (async () => {
      const res = await request({ type: 'agent:history', sessionId });
      applyHistory(res);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autoscroll on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, running, thinking]);

  // 1s tick that drives the "Working for Xs" elapsed label.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Run a turn. `echo` adds the user bubble (a normal send); the auth-retry path
  // passes echo:false because the bubble from the failed attempt is already on
  // screen, so it re-runs without duplicating it.
  function submitTurn(text: string, images: PendingImage[], opts?: { echo?: boolean }): void {
    if (hostConnected === false) return; // host required to run anything
    // runningRef (not the `running` state) so a send() that just reconciled a
    // stale-running turn to idle can start fresh without waiting for the re-render.
    if ((!text && images.length === 0) || runningRef.current) return;
    lastTurnRef.current = { text, images };
    // Record this send's thumbnails by running image index so a history rebuild
    // can re-attach them. Skip the auth-retry re-send (echo:false) — its images
    // were already recorded on the first attempt; re-recording would misalign
    // the index against the transcript.
    if (opts?.echo !== false) {
      for (const im of images) {
        if (im.thumb) thumbsRef.current[imageCountRef.current] = im.thumb;
        imageCountRef.current++;
      }
      saveThumbs(sessionIdRef.current, thumbsRef.current);
    }
    if (opts?.echo === false) {
      setItems((prev) => { turnStartRef.current = { index: prev.length, startedAt: Date.now() }; return prev; });
    } else {
      setItems((prev) => {
        turnStartRef.current = { index: prev.length + 1, startedAt: Date.now() };
        return [...prev, { kind: 'user', text, images: images.length ? images.map((im) => im.dataUrl) : undefined }];
      });
    }
    turnAppRef.current = null;
    setRunning(true);
    setLiveOpen(false);
    // Reset the watchdog clock so the first event of this turn has a full grace
    // window before a silence reconcile can fire.
    lastEventAtRef.current = Date.now();
    post({
      type: 'agent:start',
      text,
      sessionId: sessionId ?? undefined,
      windowId: windowIdRef.current,
      images: images.map((im) => ({ media_type: im.mediaType, data: im.dataUrl.split(',')[1] ?? '' })),
    });
  }

  // Send a follow-up into the turn that's already running. The daemon weaves it
  // into the live conversation (the agent picks it up at its next step) and
  // echoes it back as a user_message event; we render it optimistically now and
  // dedupe that echo by clientId.
  function submitFollowup(text: string, images: PendingImage[]): void {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const clientId = `f${nextReqId.current++}`;
    echoedFollowupIds.current.add(clientId);
    // Optimistic bubble starts "in queue" — cleared when the daemon reports the
    // message was folded into the turn (followup_injected) or the turn ends.
    setItems((prev) => [...prev, { kind: 'user', text, images: images.length ? images.map((im) => im.dataUrl) : undefined, clientId, queued: true }]);
    // Record thumbnails by running image index so a finished-session reload
    // re-attaches them (history strips image bytes), same as submitTurn.
    for (const im of images) {
      if (im.thumb) thumbsRef.current[imageCountRef.current] = im.thumb;
      imageCountRef.current++;
    }
    saveThumbs(sid, thumbsRef.current);
    post({
      type: 'agent:followup',
      sessionId: sid,
      clientId,
      text,
      windowId: windowIdRef.current,
      images: images.map((im) => ({ media_type: im.mediaType, data: im.dataUrl.split(',')[1] ?? '' })),
    });
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || hostConnected === false) return;
    // First turn still spinning up (no session id yet) — wait, don't drop input.
    if (running && !sessionIdRef.current) return;
    const images = pendingImages;
    setInput('');
    setPendingImages([]);
    if (!running) { submitTurn(text, images, { echo: true }); return; }
    // We think a turn is running — but `running` can be stale: if turn_done was
    // dropped (the daemon→panel relay has no buffer), the turn already ended on
    // the backend. Routing this as a follow-up then welds it onto a dead turn —
    // the daemon reruns it as a *fresh* turn while the panel keeps the old turn's
    // boundary, desyncing the layout (duplicated answer, detached "Working"
    // header). Confirm the true state with the daemon (source of truth) first.
    // Cheap: it only rebuilds when the turn actually ended; a live turn just
    // routes the follow-up as before.
    const sid = sessionIdRef.current;
    const res = sid ? await request({ type: 'agent:history', sessionId: sid }) : null;
    if (res && !res.running) {
      runningRef.current = false; // authoritative — let submitTurn start fresh now
      applyHistory(res);          // recover the finished transcript (the missed answer)
      submitTurn(text, images, { echo: true });
    } else {
      submitFollowup(text, images); // genuinely live (or daemon unreachable) → weave in
    }
  }
  // Latest submitTurn closure, for the storage listener (mounted with [] deps).
  submitTurnRef.current = submitTurn;

  // Paste images from the clipboard into the composer (max 4 per message).
  function onPaste(e: React.ClipboardEvent): void {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = async () => {
        if (typeof reader.result !== 'string') return;
        const dataUrl = reader.result;
        const thumb = await makeThumb(dataUrl);
        setPendingImages((prev) => (prev.length >= 4 ? prev : [...prev, { mediaType: f.type, dataUrl, thumb }]));
      };
      reader.readAsDataURL(f);
    }
  }

  function stop(): void {
    if (sessionIdRef.current) post({ type: 'agent:stop', sessionId: sessionIdRef.current });
    // Don't wait solely on turn_done: if the backend turn already died (e.g. a
    // daemon restart left a stale spinner), it never arrives and the button
    // looks dead. Fold the live turn and clear the spinner now; a genuine stop
    // confirms the same via turn_done (idempotent).
    setItems((prev) => collapseTurn(prev).map((it) =>
      it.kind === 'user' && it.queued ? { ...it, queued: false } : it));
    setRunning(false);
    setThinking(false);
    setReconnecting(false);
    turnStartRef.current = null;
    turnAppRef.current = null;
  }

  function newChat(): void {
    setSessionId(null);
    localStorage.removeItem(CURRENT_SESSION_KEY);
    setItems([]);
    setPlan(null);
    setTask(null);
    setThinking(false);
    setReconnecting(false);
    setRunning(false);
    setSessionsOpen(false);
    turnStartRef.current = null;
    lastSeqRef.current = 0;
    thumbsRef.current = {};
    imageCountRef.current = 0;
    echoedFollowupIds.current.clear();
    inputRef.current?.focus();
  }

  async function openSessions(): Promise<void> {
    setSessionsOpen(true);
    const res = await request({ type: 'agent:sessions' });
    if (res && Array.isArray(res.sessions)) setSessions(res.sessions);
  }

  async function loadSession(meta: SessionMeta): Promise<void> {
    setSessionsOpen(false);
    setSessionId(meta.id);
    localStorage.setItem(CURRENT_SESSION_KEY, meta.id);
    setItems([]);
    setPlan(null);
    setTask(null);
    lastSeqRef.current = 0;
    const res = await request({ type: 'agent:history', sessionId: meta.id });
    applyHistory(res);
  }

  // ── Live-turn presentation ──
  // While a turn runs, the stream shows only the high-level view of it:
  //   [Working for Xs ›]  — live expander at the top of the turn (all past activity)
  //   <latest narration>  — stays visible until the NEXT narration streams
  //   <status line>  — what is happening right now (tool label / Thinking)
  // On turn_done everything folds into the finished "Worked for Xs" group as before.
  // Unknown turn start (e.g. another client started the turn) → hide nothing.
  const turnStart = running ? turnStartRef.current?.index ?? items.length : null;
  const lastItem = items[items.length - 1];
  const beforeItems = turnStart === null ? items : items.slice(0, turnStart);
  const turnItems = turnStart === null ? [] : items.slice(turnStart);
  let lastTurnTextIdx = -1;
  for (let i = turnItems.length - 1; i >= 0; i--) {
    if (turnItems[i].kind === 'text') { lastTurnTextIdx = i; break; }
  }
  const hiddenActivity: ChatItem[] = [];
  const keptItems = turnItems.filter((it, i) => {
    if (it.kind !== 'tool' && it.kind !== 'text') return true; // errors, cards
    if (i === lastTurnTextIdx) return true;                    // latest narration / answer
    hiddenActivity.push(it);
    return false;
  });
  // Status line: what is happening right now, in natural language. Omitted
  // while narration itself is streaming (the text is the status then).
  let status: string | null = null;
  if (running) {
    if (reconnecting) status = 'Connection dropped — reconnecting…';
    else if (thinking || !lastItem || lastItem.kind === 'user') status = 'Thinking';
    else if (lastItem.kind === 'tool') status = toolPresentation(lastItem.name, lastItem.input, lastItem.summary, daemonOrigin, true).label;
  }
  // Elapsed time of the running turn, for the "Working for Xs" header.
  const workingSeconds = running && turnStartRef.current?.startedAt
    ? (now - turnStartRef.current.startedAt) / 1000
    : null;

  // The native host (daemon + connector) is macOS/Linux only, so on Windows
  // every host-backed feature is dead. Show an honest unsupported notice
  // instead of an endless "Disconnected" reconnect spinner.
  if (isWindows) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-4" style={{ background: 'var(--bg-primary)' }}>
        <WindowsUnsupportedBanner />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header — icon buttons left, page-apps dropdown right. Tinted a step
          darker than both Chrome's white panel title bar and the chat surface
          so each control reads as its own card on it. */}
      <div
        className="relative flex flex-col px-2 pt-3 pb-1.5 shrink-0 border-b"
        style={{ background: 'var(--gray-100)', borderColor: 'var(--border-tertiary)' }}
      >
        <div className="flex items-center">
        <div className="flex items-center gap-1.5">
          <IconButton label="New chat" Icon={Plus} onClick={newChat} />
          <IconButton label="History" Icon={History} onClick={openSessions} />
          <IconButton label="Dashboard" Icon={LayoutGrid} showLabel onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })} />
        </div>

        {(() => {
          const activeCount = pageApps.filter((a) => a.enabled).length;
          const label = pageApps.length === 0
            ? 'No apps'
            : `${activeCount} active app${activeCount === 1 ? '' : 's'}`;
          const expanded = appsOpen && pageApps.length > 0;
          const openNow = () => {
            if (appsHoverTimer.current) clearTimeout(appsHoverTimer.current);
            setAppsOpen(true);
          };
          const closeSoon = () => {
            if (appsHoverTimer.current) clearTimeout(appsHoverTimer.current);
            appsHoverTimer.current = setTimeout(() => setAppsOpen(false), 180);
          };
          return (
            <div className="ml-auto relative shrink-0" onMouseEnter={openNow} onMouseLeave={closeSoon}>
              {/* A bordered card like the icon buttons; while the dropdown is
                  open its bottom corners square off and merge into the card. */}
              <button
                className="relative inline-flex items-center gap-1.5 h-9 px-3 cursor-default text-[13px] font-medium whitespace-nowrap"
                style={{
                  color: 'var(--fg-primary)',
                  background: 'var(--bg-white)',
                  border: '1px solid var(--border-tertiary)',
                  borderBottomColor: expanded ? 'transparent' : 'var(--border-tertiary)',
                  borderRadius: expanded ? '10px 10px 0 0' : '10px',
                  zIndex: expanded ? 31 : undefined,
                }}
                data-testid="page-apps-toggle"
              >
                <span
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ background: activeCount > 0 ? 'var(--olive)' : 'var(--gray-300)' }}
                />
                {label}
                {/* Rendered in both states — a collapsed-only icon changes the
                    trigger width, which loops open/close under a cursor near
                    its left edge (hover target grows into the cursor). */}
                {pageApps.some((a) => a.error) && (
                  <CircleAlert size={14} className="shrink-0" style={{ color: 'var(--error)' }} />
                )}
                <ChevronDown
                  size={14}
                  className="shrink-0 transition-transform duration-150"
                  style={{ transform: expanded ? 'rotate(180deg)' : 'none', color: 'var(--fg-tertiary)' }}
                />
              </button>

              {/* Card — flush under the trigger, overlays the chat below.
                  Rows styled like the dashboard's lists: name + status line,
                  hairline dividers. */}
              {expanded && (
                <div
                  className="absolute right-0 z-30 border overflow-hidden"
                  style={{
                    top: 'calc(100% - 1px)',
                    background: 'var(--bg-white)',
                    borderColor: 'var(--border-tertiary)',
                    borderRadius: '10px 0 10px 10px',
                    boxShadow: '0 10px 28px rgba(17, 17, 16, 0.14)',
                    // Fit the widest row, but never narrower than the trigger
                    // (keeps the connected-card look) nor wider than the cap
                    // (long titles truncate instead).
                    width: 'max-content',
                    minWidth: '100%',
                    maxWidth: 280,
                  }}
                  data-testid="page-apps-dropdown"
                >
                  <div className="overflow-y-auto thin-scroll" style={{ maxHeight: 'min(55vh, 320px)' }}>
                    {pageApps.map((a, i) => {
                      // Visible: app has on-page UI. Enabled: injected but
                      // rendering nothing here. Active: probe unavailable.
                      const status = a.error
                        ? { text: 'Error', color: 'var(--error)', title: 'Missing secrets — open the dashboard to set them' }
                        : !a.enabled
                          ? { text: 'Disabled', color: 'var(--fg-tertiary)' }
                          : a.visible === true
                            ? { text: 'Visible', color: 'var(--olive)' }
                            : a.visible === false
                              ? { text: 'Enabled', color: 'var(--sky)' }
                              : { text: 'Active', color: 'var(--olive)' };
                      return (
                        <button
                          key={a.id}
                          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?app=${a.id}`) })}
                          className="flex items-center gap-3 w-full text-left px-3.5 py-2 cursor-pointer"
                          style={{ background: 'transparent', border: 0, borderTop: i > 0 ? '1px solid var(--border-tertiary)' : undefined }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span
                            className="flex-1 text-[13.5px] font-medium truncate"
                            style={{ color: a.enabled ? 'var(--fg-primary)' : 'var(--fg-tertiary)' }}
                          >
                            {a.name}
                          </span>
                          <span
                            className="inline-flex items-center gap-1.5 text-[12px] font-medium shrink-0"
                            style={{ color: status.color }}
                            title={status.title}
                          >
                            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: status.color }} />
                            {status.text}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
        </div>

        {/* Agent's current task — integrated into the header as a second line:
            a blue dot then the plain-language objective set via the `task` tool. */}
        {task && (
          <div className="flex items-center gap-2 mt-2 px-1 min-w-0">
            <span className="shrink-0 text-[13.5px]" style={{ color: 'var(--fg-tertiary)' }}>Task</span>
            <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--sky)' }} />
            <span className="truncate font-normal text-[14px]" style={{ color: 'var(--fg-primary)' }}>{task}</span>
          </div>
        )}
      </div>

      {/* Server-driven announcement — pinned at the top of the panel
          (Edge Config → /api/announcement → background poll → storage cache).
          Renders nothing (no gap) when there's no active announcement. */}
      <div className="shrink-0">
        <AnnouncementBanner compact />
      </div>

      {/* Agent's step plan — pinned above the stream (the objective now lives
          in the header's second line, above). */}
      {plan && plan.length > 0 && <PinnedPlan items={plan} />}

      {/* Sessions drawer — same language as the header: tinted bar, one
          white card with hairline-divided rows (dashboard list style). */}
      {sessionsOpen && (
        <div className="absolute inset-0 z-20 flex flex-col" style={{ background: 'var(--bg-primary)' }}>
          <div className="flex items-center px-3 h-12 shrink-0 border-b" style={{ background: 'var(--gray-100)', borderColor: 'var(--border-tertiary)' }}>
            <div className="text-[14px] font-semibold" style={{ color: 'var(--fg-primary)' }}>Past chats</div>
            <div className="ml-auto">
              <IconButton label="Close" Icon={X} onClick={() => setSessionsOpen(false)} align="right" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto thin-scroll p-3">
            {sessions.length === 0 ? (
              <div className="text-[13px] p-3" style={{ color: 'var(--fg-tertiary)' }}>No past chats yet.</div>
            ) : (
              <div
                className="rounded-sm border overflow-hidden"
                style={{ background: 'var(--bg-white)', borderColor: 'var(--border-tertiary)' }}
              >
                {sessions.map((s, i) => (
                  <button
                    key={s.id}
                    onClick={() => loadSession(s)}
                    className="block w-full text-left px-3.5 py-2.5 cursor-pointer"
                    style={{ background: 'transparent', border: 0, borderTop: i > 0 ? '1px solid var(--border-tertiary)' : undefined }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div className="text-[13.5px] font-medium truncate" style={{ color: 'var(--fg-primary)' }}>
                      {s.title || 'Untitled'}
                    </div>
                    <div className="text-[11.5px] mt-0.5 flex gap-2" style={{ color: 'var(--fg-tertiary)' }}>
                      {s.appName && <span className="truncate">{s.appName}</span>}
                      <span className="shrink-0">{new Date(s.updatedAt).toLocaleString()}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Ordered setup gate: install host → pin to toolbar. Only the
          highest-priority unmet step shows; it polls so each banner clears
          itself once satisfied. (Windows is handled by the full-screen takeover
          above; sign-in and enabling User Scripts by the blocking overlays
          below, which supersede the old inline banners here.) */}
      <SetupBanners variant="sidepanel" steps={['host', 'pin']} onActiveChange={setSetupStep} />

      {/* Hide the panel's working surface (missing-keys, chat, composer) while
          the pin banner is up — the user pins Airglow before anything else.
          Overlays (sign-in, user-scripts) and the banner itself stay visible. */}
      {setupStep !== 'pin' && (<>

      {/* Missing env keys for apps active on this tab */}
      {hostConnected !== false && (
        <MissingKeysCard
          daemonOrigin={daemonOrigin}
          running={running}
          activeAppIds={pageApps.filter((a) => a.enabled).map((a) => a.id)}
        />
      )}

      {/* Message stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto thin-scroll px-3 py-3">
        {items.length === 0 && hostConnected !== false && (
          // min-h-full + mt-auto bottom-aligns the empty state on a tall panel
          // but lets it grow and scroll on a short one — flex `items-end` would
          // push the top (the banner) above the scroll origin where it can't be
          // reached, hiding it behind the header.
          <div className="min-h-full flex flex-col items-center pb-2">
            <div className="w-full max-w-[320px] mt-auto">
              <div
                className="mb-16 p-3.5 rounded-[8px] border text-left"
                style={{
                  background: 'color-mix(in srgb, var(--sky) 8%, var(--bg-white))',
                  borderColor: 'color-mix(in srgb, var(--sky) 30%, var(--border-tertiary))',
                }}
              >
                <div className="text-base font-semibold" style={{ color: 'var(--fg-primary)' }}>Prefer your own coding agent?</div>
                <div className="mt-2.5 text-sm leading-relaxed" style={{ color: 'var(--fg-secondary)' }}>
                  Run{' '}
                  <code className="px-1 py-0.5 rounded font-mono text-[0.8em]" style={{ background: 'color-mix(in srgb, var(--sky) 18%, var(--bg-white))', color: 'var(--fg-primary)' }}>codex/claude</code>{' '}
                  in{' '}
                  <code className="px-1 py-0.5 rounded font-mono text-[0.8em]" style={{ background: 'color-mix(in srgb, var(--sky) 18%, var(--bg-white))', color: 'var(--fg-primary)' }}>~/.airglow</code>{' '}
                  and ask it to build your app.
                </div>
              </div>
              <div className="text-2xl font-bold tracking-tight mb-7 text-center" style={{ color: 'var(--fg-primary)' }}>Ask Airglow to improve this page</div>
              <div className="flex flex-col gap-2">
                {([
                  { Icon: Wand2, title: 'Customize', text: 'Block shorts video on Youtube', color: 'var(--clay)' },
                  { Icon: Workflow, title: 'Automate', text: 'Integrate my HubSpot data into Linkedin', color: 'var(--olive)' },
                  { Icon: Bot, title: 'Delegate', text: 'Clean spreadsheet table for me', color: 'var(--sky)' },
                ] as const).map(({ Icon, title, text, color }) => (
                  <div
                    key={title}
                    className="flex flex-col items-center text-center gap-1.5 p-3 rounded-xl border-2"
                    style={{ background: 'var(--bg-white)', borderColor: `color-mix(in srgb, ${color} 60%, var(--bg-white))` }}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg"
                        style={{ background: `color-mix(in srgb, ${color} 12%, var(--bg-white))`, color }}
                      >
                        <Icon size={18} strokeWidth={1.9} />
                      </span>
                      <span className="text-lg font-semibold" style={{ color: 'var(--fg-primary)' }}>{title}</span>
                    </span>
                    <span className="text-base leading-relaxed" style={{ color: 'var(--fg-tertiary)' }}>{text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {(() => {
          const renderItem = (item: ChatItem, i: string) => {
          if (item.kind === 'user') {
            return (
              <div key={i} className="mt-7 mb-3 flex justify-end">
                <div
                  className="relative max-w-[85%] px-3.5 py-2.5 rounded-2xl border text-[15px] leading-relaxed whitespace-pre-wrap break-words"
                  style={{
                    background: 'var(--bg-white)',
                    borderColor: item.queued ? 'color-mix(in srgb, var(--clay) 35%, var(--border-tertiary))' : 'var(--border-tertiary)',
                    color: 'var(--fg-primary)',
                  }}
                >
                  {/* Follow-up sent mid-turn, not yet folded into the conversation */}
                  {item.queued && (
                    <span
                      className="absolute -top-2.5 right-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium border whitespace-nowrap"
                      style={{ background: 'var(--bg-white)', borderColor: 'color-mix(in srgb, var(--clay) 35%, var(--border-tertiary))', color: 'var(--clay-interactive)' }}
                      data-testid="followup-queued-pill"
                    >
                      <Hourglass size={9} /> In queue
                    </span>
                  )}
                  {item.images && item.images.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {item.images.map((src, j) => src ? (
                        <img key={j} src={src} alt="attachment" className="rounded-lg border max-h-32 max-w-full" style={{ borderColor: 'var(--border-tertiary)' }} />
                      ) : (
                        <span key={j} className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md" style={{ background: 'var(--bg-tertiary)', color: 'var(--fg-tertiary)' }}>
                          <ImageIcon size={12} /> image
                        </span>
                      ))}
                    </div>
                  )}
                  {item.text}
                </div>
              </div>
            );
          }
          if (item.kind === 'text') {
            return (
              <div key={i} className="my-3 text-[15px] leading-relaxed" style={{ color: 'var(--fg-primary)' }}>
                <Markdown text={item.text} />
              </div>
            );
          }
          if (item.kind === 'tool') return <ToolRow key={item.toolId} item={item} daemonOrigin={daemonOrigin} />;
          if (item.kind === 'work') return <WorkGroup key={i} item={item} daemonOrigin={daemonOrigin} />;
          if (item.kind === 'appcard') return <AppCard key={i} appId={item.appId} name={item.name} />;
          if (item.kind === 'error' && item.code === 'AGENT_BUDGET_EXCEEDED') {
            return (
              <div key={i} className="my-2 p-3 rounded-xl border flex items-start gap-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-secondary)' }}>
                <CircleAlert size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--error)' }} />
                <div className="break-words min-w-0">
                  <div className="text-[16.5px] font-semibold leading-snug" style={{ color: 'var(--error)' }}>Weekly budget limit reached</div>
                  <div className="text-[13.5px] leading-relaxed mt-1" style={{ color: 'var(--fg-secondary)' }}>
                    Your limit will reset in {item.resetHours ? `${item.resetHours} hours` : 'a few days'}.
                  </div>
                  <div className="text-[16.5px] font-semibold mt-2 leading-snug" style={{ color: 'var(--fg-primary)' }}>Use Airglow for free with your coding agent</div>
                  <div className="text-[13.5px] leading-relaxed mt-1" style={{ color: 'var(--fg-secondary)' }}>
                    Run your coding agent from{' '}
                    <code style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.92em', padding: '1px 5px', borderRadius: '5px', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)' }}>~/.airglow</code>{' '}
                    folder. Or ask for a budget limit increase through{' '}
                    <button
                      onClick={() => setFeedbackOpen(true)}
                      className="cursor-pointer"
                      style={{ color: 'var(--fg-primary)', background: 'transparent', border: 0, padding: 0, font: 'inherit', textDecoration: 'underline' }}
                    >
                      Feedback Form
                    </button>.
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div key={i} className="my-2 p-2.5 rounded-xl text-[13px] flex items-start gap-2" style={{ background: 'color-mix(in srgb, var(--error) 8%, var(--bg-white))', color: 'var(--error)' }}>
              <CircleAlert size={15} className="shrink-0 mt-0.5" />
              <span className="break-words min-w-0">{item.text}</span>
            </div>
          );
          };
          return (
            <>
              {beforeItems.map((item, i) => renderItem(item, `b${i}`))}
              {/* Live header — elapsed time; expands into everything the running turn already did */}
              {workingSeconds !== null && (
                <div className="my-2">
                  <button
                    onClick={() => hiddenActivity.length > 0 && setLiveOpen(!liveOpen)}
                    className="flex items-center gap-1.5 text-[13px] px-1 py-0.5 rounded-sm"
                    style={{ color: 'var(--fg-tertiary)', background: 'transparent', border: 0, cursor: hiddenActivity.length > 0 ? 'pointer' : 'default' }}
                    onMouseEnter={(e) => { if (hiddenActivity.length > 0) e.currentTarget.style.color = 'var(--fg-secondary)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-tertiary)'; }}
                    data-testid="live-steps-toggle"
                  >
                    Working for {fmtDuration(workingSeconds)}
                    {hiddenActivity.length > 0 && (liveOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
                  </button>
                  {liveOpen && hiddenActivity.length > 0 && (
                    <div className="mt-1">
                      <ActivityList daemonOrigin={daemonOrigin}>{hiddenActivity}</ActivityList>
                    </div>
                  )}
                </div>
              )}
              {keptItems.map((item, i) => renderItem(item, `t${i}`))}
            </>
          );
        })()}
        {status && (
          reconnecting ? (
            <div
              className="my-2 text-[13px] flex items-center gap-1.5 truncate"
              style={{ color: 'var(--clay-interactive)' }}
              data-testid="live-status"
            >
              <CircleAlert size={13} className="shrink-0" />
              <span className="truncate">{status}</span>
            </div>
          ) : (
            <div className="my-2 text-[13px] thinking-shimmer truncate" data-testid="live-status">{status}</div>
          )
        )}
      </div>

      {/* Composer */}
      <div className="p-3 shrink-0">
        <div
          className="rounded-sm border py-2 pl-4 pr-2 cursor-text"
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-secondary)', boxShadow: 'var(--shadow-sm)' }}
          onMouseDown={(e) => {
            // Clicking the composer's padding/edges should focus the input rather
            // than do nothing; leave the textarea and buttons to their own handling.
            if (e.target !== inputRef.current && !(e.target as HTMLElement).closest('button')) {
              e.preventDefault();
              inputRef.current?.focus();
            }
          }}
        >
          {pendingImages.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1 pb-2">
              {pendingImages.map((im, i) => (
                <div key={i} className="relative">
                  <img src={im.dataUrl} alt="attachment" className="w-12 h-12 object-cover rounded-lg border" style={{ borderColor: 'var(--border-secondary)' }} />
                  <button
                    onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                    title="Remove image"
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full inline-flex items-center justify-center cursor-pointer"
                    style={{ background: 'var(--gray-950)', color: 'var(--bg-white)', border: 0, padding: 0 }}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
          <textarea
            ref={inputRef}
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              } else if (e.key === 'Escape' && running) {
                e.preventDefault();
                stop();
              }
            }}
            disabled={hostConnected === false}
            placeholder={hostConnected === false ? 'Install the Airglow host to start chatting' : running ? 'Add a follow-up…' : 'Describe what to change on website'}
            rows={1}
            className="flex-1 resize-none outline-none text-[14.5px] bg-transparent self-center disabled:cursor-not-allowed thin-scroll"
            style={{ color: 'var(--fg-primary)', border: 0, lineHeight: '21px', maxHeight: 105, overflowY: 'auto', fieldSizing: 'content' } as React.CSSProperties}
            data-testid="composer-input"
          />
          {/* Stop is present whenever a turn runs; Send joins it as soon as
              there's something to send — so a follow-up can go out mid-turn
              while Stop stays one tap away. Idle, only Send shows (as before). */}
          {running && (
            <button
              onClick={stop}
              title="Stop"
              className="inline-flex items-center justify-center w-9 h-9 rounded-full shrink-0 border cursor-pointer"
              style={{ background: 'var(--gray-950)', borderColor: 'var(--gray-950)', color: 'var(--bg-white)' }}
              data-testid="composer-stop"
            >
              <Square size={12} fill="currentColor" />
            </button>
          )}
          {(() => {
            const hasContent = input.trim().length > 0 || pendingImages.length > 0;
            if (running && !hasContent) return null;
            const enabled = hasContent && hostConnected !== false;
            return (
              <button
                onClick={send}
                disabled={!enabled}
                title={running ? 'Send follow-up' : 'Send'}
                className="inline-flex items-center justify-center w-9 h-9 rounded-full shrink-0 border"
                style={{
                  background: enabled ? 'var(--clay)' : 'var(--bg-tertiary)',
                  borderColor: enabled ? 'var(--clay)' : 'var(--border-secondary)',
                  color: enabled ? 'var(--bg-white)' : 'var(--fg-tertiary)',
                  cursor: enabled ? 'pointer' : 'not-allowed',
                }}
                data-testid="composer-send"
              >
                <ArrowUp size={17} strokeWidth={2.4} />
              </button>
            );
          })()}
          </div>
        </div>
        {/* Composer footer — escape-hatch hint, repo link, feedback. */}
        <div className="flex items-center gap-1 px-1 pt-2">
          <ComposerTool
            Icon={HelpCircle}
            label="Agent"
            tooltip={
              <>
                <div><strong style={{ fontWeight: 600, color: 'var(--fg-primary)' }}>Prefer your own coding agent?</strong></div>
                <div style={{ marginTop: '0.4em' }}>Run <code style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.92em', padding: '1px 5px', borderRadius: '5px', background: 'var(--bg-tertiary)' }}>codex/claude</code> in <code style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.92em', padding: '1px 5px', borderRadius: '5px', background: 'var(--bg-tertiary)' }}>~/.airglow</code> and ask it to build your app.</div>
              </>
            }
          />
          <ComposerTool
            Icon={GithubIcon}
            label="Github"
            tooltip="Submit an issue or PR"
            href={GITHUB_REPO_URL}
          />
          <ComposerTool
            Icon={MessageSquare}
            label="Feedback"
            onClick={() => setFeedbackOpen(true)}
          />
          {/* Version + self-update, bottom-right. The Update button only shows
              once Chrome has staged a newer Web Store build (never in dev). */}
          <div className="ml-auto flex items-center gap-1.5 pr-1 relative top-1" data-testid="sidepanel-version">
            <span style={{ color: 'var(--fg-tertiary)', fontSize: '11px' }}>v{chrome.runtime.getManifest().version}</span>
            {extUpdate && (
              <button
                type="button"
                onClick={applyExtUpdate}
                className="h-5 px-2 rounded-sm cursor-pointer border-0 font-medium"
                style={{ background: 'var(--olive)', color: 'var(--bg-white)', fontSize: '11px' }}
                title={`Update to v${extUpdate}`}
                data-testid="sidepanel-ext-update-button"
              >
                Update
              </button>
            )}
          </div>
        </div>
      </div>
      </>)}

      <FeedbackModal
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        source={{ appId: 'sidepanel', appName: 'Airglow Sidepanel', sourceType: 'extension-sidepanel' }}
      />

      {/* Blocking gates — each covers the whole panel until its requirement is
          met. User Scripts is a Chrome permission the extension can't inject
          without; the auth gate keeps the agent unmessageable signed-out and
          stacks on top (documented priority: sign-in before User Scripts). */}
      <UserScriptsOverlay />
      <SignInOverlay />
    </div>
  );
}

// A labeled icon button in the composer footer with a white tooltip pill
// that floats above it on hover (the footer sits at the panel's bottom edge,
// so the tooltip opens upward). The tooltip uses `w-max max-w-[280px]` so it
// sizes to its content up to a cap instead of collapsing to the icon-width
// container and wrapping every word. Renders an anchor when `href` is set.
// GitHub mark as an inline SVG. lucide-react deprecated its brand/logo icons
// (Github, etc.) over trademark concerns and will drop them; we render the
// official mark ourselves so there's no dependency on a deprecated export.
// Filled glyph, so it follows `currentColor` and ignores strokeWidth.
function GithubIcon({ size = 16 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function ComposerTool({ Icon, label, tooltip, onClick, href }: { Icon: ComponentType<{ size?: number; strokeWidth?: number }>; label: string; tooltip?: ReactNode; onClick?: () => void; href?: string }) {
  const [hover, setHover] = useState(false);
  const clickable = !!href || !!onClick;
  // Tooltip is purely informational and not interactive: close it the instant
  // the pointer leaves the trigger so it can't be hovered onto.
  const open = () => setHover(true);
  const close = () => setHover(false);
  const cls = `inline-flex items-center gap-1.5 h-7 px-2 rounded-lg text-[12.5px] font-medium ${clickable ? 'cursor-pointer' : 'cursor-default'}`;
  const style = {
    color: 'var(--fg-tertiary)',
    background: hover ? 'var(--gray-150)' : 'transparent',
    border: 0,
  } as const;
  const inner = (
    <>
      <Icon size={15} strokeWidth={1.9} />
      <span>{label}</span>
    </>
  );
  return (
    <span className="relative inline-flex">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
          onMouseEnter={open}
          onMouseLeave={close}
          className={cls}
          style={style}
        >
          {inner}
        </a>
      ) : (
        <button
          onClick={onClick}
          aria-label={label}
          onMouseEnter={open}
          onMouseLeave={close}
          className={cls}
          style={style}
        >
          {inner}
        </button>
      )}
      {hover && tooltip && (
        <span
          className="absolute bottom-full left-0 mb-1.5 z-40 w-max max-w-[260px] px-3 py-2 rounded-lg text-[12.5px] font-normal leading-relaxed border pointer-events-none"
          style={{ background: 'var(--bg-white)', color: 'var(--fg-secondary)', borderColor: 'var(--border-primary)', boxShadow: '0 6px 22px rgba(17, 17, 16, 0.16)' }}
        >
          {tooltip}
        </span>
      )}
    </span>
  );
}

// Icon button as its own bordered card on the header bar, with a white
// tooltip pill below it on hover. `align` anchors the tooltip edge so
// buttons near the panel's right edge don't overflow it. `showLabel`
// renders the label inline next to the icon instead of as a tooltip.
function IconButton({ label, Icon, onClick, align = 'left', showLabel = false }: { label: string; Icon: typeof Plus; onClick: () => void; align?: 'left' | 'right'; showLabel?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        onClick={onClick}
        aria-label={label}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={`inline-flex items-center justify-center h-9 rounded-sm cursor-pointer ${showLabel ? 'gap-1.5 px-3' : 'w-9'}`}
        style={{
          color: 'var(--fg-secondary)',
          background: hover ? 'var(--gray-150)' : 'var(--bg-white)',
          border: `1px solid ${hover ? 'var(--border-secondary)' : 'var(--border-tertiary)'}`,
        }}
      >
        <Icon size={18} strokeWidth={1.9} />
        {showLabel && <span className="text-[13px] font-semibold">{label}</span>}
      </button>
      {hover && !showLabel && (
        <span
          className={`absolute top-full ${align === 'right' ? 'right-0' : 'left-0'} mt-1.5 z-40 px-3 py-1.5 rounded-xl text-[13px] font-semibold whitespace-nowrap pointer-events-none`}
          style={{ background: 'var(--bg-white)', color: 'var(--fg-primary)', boxShadow: '0 4px 16px rgba(17, 17, 16, 0.14)' }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

// Rebuild the chat stream from persisted Anthropic-format messages, applying
// the same collapse rule as live turns: per assistant turn, everything except
// the final text answer goes into a WorkGroup. The group's "Worked for X"
// duration comes from the per-message timestamps (`times`, index-aligned with
// `messages`): turn start = the user message that opened it, end = the turn's
// last message; missing timestamps (legacy sessions) → plain "Worked".
// Thinking blocks are dropped entirely; the last plan tool call becomes the
// pinned plan. Image data is stripped in transport (1MB native-messaging cap)
// — user images arrive as {source:{type:'stripped'}} and render as
// placeholder chips.
function reconstructItems(messages: any[], meta: any, times?: number[], thumbs?: Record<number, string>, imgOffset = 0): { items: ChatItem[]; plan: PlanItem[] | null; task: string | null } {
  const items: ChatItem[] = [];
  let plan: PlanItem[] | null = null;
  let task: string | null = null;
  // Running index of attached user images across this transcript — matches the
  // key thumbnails were stored under, so a stripped block re-attaches its preview.
  let imgIdx = imgOffset;
  const resultById = new Map<string, { ok: boolean; summary: string }>();
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
            : '';
        resultById.set(block.tool_use_id, { ok: !block.is_error, summary: truncateWithNote(text, SUMMARY_CHARS) });
      }
    }
  }

  let turn: ChatItem[] = [];
  // Wall-clock bounds (ms) of the assistant turn currently in `turn`, from the
  // persisted per-message timestamps — start = the user message that opened it,
  // end = the latest turn message. Drives "Worked for X" on reload; null
  // (legacy sessions without timestamps) → plain "Worked".
  let turnStartTs: number | null = null;
  let turnEndTs: number | null = null;

  const flushTurn = () => {
    if (turn.length === 0) return;
    let lastTextIdx = -1;
    for (let i = turn.length - 1; i >= 0; i--) {
      if (turn[i].kind === 'text') { lastTextIdx = i; break; }
    }
    const collapsible = turn.filter((_, i) => i !== lastTextIdx);
    if (collapsible.length > 0) {
      const seconds = turnStartTs != null && turnEndTs != null && turnEndTs > turnStartTs
        ? (turnEndTs - turnStartTs) / 1000
        : 0;
      items.push({ kind: 'work', seconds, children: collapsible });
    }
    if (lastTextIdx >= 0) items.push(turn[lastTextIdx]);
    turn = [];
  };

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const ts = times?.[mi];
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }];
    if (msg.role === 'user') {
      // tool_result user messages belong to the running turn — extend its end.
      if (typeof ts === 'number' && blocks.some((b: any) => b.type === 'tool_result')) turnEndTs = ts;
      // Images precede their text in a user message; attach them to it.
      let images: (string | null)[] = [];
      for (const block of blocks) {
        if (block.type === 'image') {
          // Full bytes when present (live turn); else the stored thumbnail
          // (history reload strips bytes); else a placeholder chip (null).
          const full = block.source?.type === 'base64' ? `data:${block.source.media_type};base64,${block.source.data}` : null;
          images.push(full ?? thumbs?.[imgIdx] ?? null);
          imgIdx++;
        } else if (block.type === 'text' && block.text) {
          // Daemon-injected tab snapshot (session.ts formatTabContext) — context
          // for the agent, not a user-authored message; keep it out of the bubble.
          if (block.text.startsWith('<airglow-context>')) continue;
          flushTurn();
          items.push({ kind: 'user', text: block.text, images: images.length ? images : undefined });
          images = [];
          // This user message opens the next turn.
          turnStartTs = typeof ts === 'number' ? ts : null;
          turnEndTs = typeof ts === 'number' ? ts : null;
        }
      }
    } else {
      // Assistant messages run through to the turn's final answer — the latest
      // one bounds the turn's end.
      if (typeof ts === 'number') turnEndTs = ts;
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          turn.push({ kind: 'text', text: block.text });
        } else if (block.type === 'server_tool_use') {
          turn.push({ kind: 'tool', toolId: block.id, name: block.name, input: block.input ?? {}, status: 'ok', summary: '' });
        } else if (block.type === 'web_search_tool_result') {
          // Attach results to the preceding server_tool_use row. Mirrors the
          // daemon's live tool_end summary (session.ts formatWebSearchResult).
          for (let i = turn.length - 1; i >= 0; i--) {
            const it = turn[i];
            if (it.kind === 'tool' && it.toolId === block.tool_use_id) {
              const ok = Array.isArray(block.content);
              it.status = ok ? 'ok' : 'error';
              it.summary = ok
                ? block.content
                    .filter((r: any) => r?.type === 'web_search_result')
                    .map((r: any) => `${r.title ?? '(untitled)'} — ${r.url ?? ''}`)
                    .join('\n') || '(no results)'
                : `search failed: ${block.content?.error_code ?? 'unknown'}`;
              break;
            }
          }
        } else if (block.type === 'tool_use') {
          if (block.name === 'plan' && Array.isArray(block.input?.items)) {
            plan = block.input.items;
            continue;
          }
          if (block.name === 'task' && typeof block.input?.title === 'string') {
            task = block.input.title;
            continue;
          }
          const result = resultById.get(block.id);
          turn.push({
            kind: 'tool',
            toolId: block.id,
            name: block.name,
            input: block.input ?? {},
            status: result ? (result.ok ? 'ok' : 'error') : 'ok',
            summary: result?.summary ?? '',
          });
        }
      }
    }
  }
  flushTurn();
  if (meta?.appId) items.push({ kind: 'appcard', appId: meta.appId, name: meta.appName || meta.appId });
  return { items, plan, task };
}
