import { Fragment, useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, Settings, KeyRound, AlertTriangle, Eye, EyeOff, TriangleAlert, ScrollText, MessageSquare, X, LayoutGrid, Store, ChevronRight, Globe, Copy, Check, Download, Play, Pause, Code, LoaderCircle } from 'lucide-react';
import { AnnouncementBanner } from '../../components/AnnouncementBanner';
import type { Announcement } from '../../lib/announcements';

// ?debug-announcement=1 renders this sample in place of the real (storage-fed)
// announcement — preview the banner in the actual dashboard without publishing.
const DEBUG_ANNOUNCEMENT: Announcement = {
  id: 'debug-preview',
  publishedAt: 0,
  title: 'Airglow host needs a one-time reinstall',
  body:
    'Your installed host version has a broken self-updater and cannot update itself. ' +
    'Run this once in a terminal to get the latest version:\n\n' +
    '`curl -fsSL https://airglow.dev/install.sh | bash`\n\n' +
    'Everything else keeps working in the meantime.',
  severity: 'critical',
  audience: 'all',
};
const debugAnnouncement = new URLSearchParams(window.location.search).has('debug-announcement');

// GitHub mark (lucide deprecated its brand icons).
function GithubLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
import logoUrl from '../../lib/branding/icon.svg';

// Chrome's "Extensions" toolbar icon — Material Symbols "extension" (outlined).
// (Apache 2.0, https://fonts.google.com/icons?icon.query=extension)
import LogsPage from './LogsPage';
import { FeedbackModal } from '../../components/FeedbackModal';
import { SetupBanners, type SetupStep } from '../../components/SetupBanners';
import { UserScriptsOverlay } from '../../components/UserScriptsOverlay';
import { useExtUpdateAvailable, applyExtUpdate } from '../../lib/ext-update';
import { useHostVersion } from '../../lib/host-version';
import { AUTH_SESSION_KEY, AuthCancelledError, getStoredSession, signInWithGoogle, signOut, type AuthSession } from '../../lib/airglow-auth';
import { CLOUD_API_URL_OVERRIDE_KEY, checkCloudApiReachable, getCloudApiUrl, getDefaultCloudApiUrl } from '../../lib/cloud-api';
import { DAEMON_DISABLED_KEY } from '../../lib/app-loader';

const APP_ORDER_KEY = '__app_order';
// Set once the "Develop apps" guide popup has been closed (it auto-opens on
// startup until then; the sidebar button reopens it).
const DEV_GUIDE_SEEN_KEY = '__dev_guide_seen';
const DEV_GUIDE_AGENT_CMD = 'cd ~/.airglow && claude';
const DEV_GUIDE_EXAMPLE_PROMPT = 'Create an app that hides YouTube Shorts';

// Numbered step chip for the guide popup — same shape as SetupBanners' Step,
// clay-tinted instead of error-red (it's a guide, not a warning).
function GuideStep({ n }: { n: number }) {
  return (
    <span
      className="shrink-0 text-[13px] font-medium w-6 h-6 inline-flex items-center justify-center rounded-full"
      style={{ background: 'color-mix(in srgb, var(--clay) 18%, var(--bg-white))', color: 'var(--clay)' }}
    >
      {n}
    </span>
  );
}
const LOGS_LAST_SEEN_KEY = '__logs_last_seen_ts';
const SIDE_BUTTON_KEY = '__side_button_enabled';
// DEPRECATED: the sidepanel agent chat is retired — toggle kept only for
// existing installs (see entrypoints/sidepanel/App.tsx header). Don't route
// anything new to the sidepanel.
const SIDEPANEL_KEY = '__sidepanel_enabled';
type AppVisibility = 'public' | 'hidden';

interface AppManifest {
  id: string;
  name: string;
  description: string;
  server_env?: Record<string, { label?: string }>;
  visibility?: AppVisibility;
  // Loader-injected: which source serves this app ('local' daemon or 'cloud')
  // and its base URL — the UI iframe + uninstall path follow it.
  _sourceType?: 'local' | 'cloud';
  _source?: { url: string; type: string };
  // Daemon-injected: names of `server/*.ts` RPC handlers. Non-empty list
  // means RPC calls will fail when the daemon is down — surfaced as a
  // warning chip in the dashboard.
  _serverFunctions?: string[];
  version?: string;
}

// One app in the cloud catalog index (GET <cloud>/api/catalog).
// SCHEMA SYNC: the cloud relay whitelists fields — a new field must also be
// added in airglow-catalog/scripts/build-catalog.mjs (writer) and
// airglow-cloud/lib/catalog/feed.ts (interface + normalize).
interface CatalogApp {
  id: string;
  name: string;
  version: string;
  // Short copy (1–2 lines) shown on both the card and the detail page.
  description: string;
  // Card media (absolute URLs into the catalog repo): hover-play video + its
  // poster frame. Optional — apps without media render a monogram placeholder.
  media?: { video?: string; thumbnail?: string } | null;
  // Display label for where the app runs ("Google"), from manifest.website.
  // Absent → derived from match patterns (siteWord).
  website?: string;
  // Userscript match patterns, so the catalog card can show the same site list
  // as the installed gallery. Absent on older feeds → no site row.
  matches?: string[];
  // The app has server functions — it can only run daemon-served.
  requiresHost?: boolean;
  // Full app manifest for cloud-buildable apps (null when daemon-only) — its
  // presence means the cloud can serve the app's UI for the detail preview.
  manifest?: Record<string, unknown> | null;
}

// One command; install.sh handles platform detection + native-host registration.
const HOST_INSTALL_CMD = 'curl -fsSL https://airglow.dev/install.sh | bash';

// Catalog install provenance from the daemon (GET /api/catalog/installed).
interface Provenance {
  catalogVersion: string;
  modified: boolean;
}

// a > b, by dotted numeric version.
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

// Declared env keys per app, from the daemon. Values never reach the
// extension — only set-ness, the value's source, and a masked tail.
// source 'ui' = entered in this UI (clearable), 'env' = developer .env file.
interface AppEnvKey {
  key: string;
  label?: string;
  set: boolean;
  source?: 'ui' | 'env';
  maskedTail?: string;
}
interface AppEnvStatus {
  appId: string;
  name: string;
  keys: AppEnvKey[];
}

const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:3222';

interface ConnectedAccount {
  id: string;
  appId: string;
  account: string;
  toolkit: string;
  status: string;
  createdAt?: string;
}

async function getDaemonOrigin(): Promise<string> {
  const stored = await chrome.storage.local.get('__daemon_origin');
  const origin = stored['__daemon_origin'];
  return typeof origin === 'string' ? origin : DEFAULT_DAEMON_ORIGIN;
}

function GoogleLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function isVisibleApp(app: AppManifest): boolean {
  return app.id !== 'dashboard';
}

// Canonical sidebar nav row — mirrors host/seed/shared/components/AppSidebar so
// the dashboard and app pages share one navigation language.
function NavRow({
  icon: Icon, label, active, muted, badge, disabled, title, onClick, testId,
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  active?: boolean;
  muted?: boolean;
  badge?: React.ReactNode;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  testId: string;
}) {
  const color = active ? 'var(--olive)' : muted ? 'var(--fg-tertiary)' : 'var(--fg-secondary)';
  const bg = active ? 'color-mix(in srgb, var(--olive) 12%, transparent)' : 'transparent';
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-2.5 px-3 py-2 rounded-md text-base border-0 bg-transparent text-left w-full transition-colors"
      style={{ color, background: bg, fontWeight: active ? 600 : 500, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}
      onMouseEnter={(e) => { if (disabled) return; e.currentTarget.style.background = active ? 'color-mix(in srgb, var(--olive) 20%, transparent)' : 'var(--gray-200)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = bg; }}
    >
      <Icon size={17} />
      {label}
      {badge != null && <span className="ml-auto">{badge}</span>}
    </button>
  );
}

// Per-app quick link, indented under the Apps section.
function AppRow({
  name, active, onClick, testId,
}: {
  name: string;
  active?: boolean;
  onClick?: () => void;
  testId: string;
}) {
  const color = active ? 'var(--olive)' : 'var(--fg-secondary)';
  const bg = active ? 'color-mix(in srgb, var(--olive) 12%, transparent)' : 'transparent';
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex items-center pl-[38px] pr-3 py-1.5 rounded-md text-[15px] border-0 bg-transparent text-left w-full truncate transition-colors"
      style={{ color, background: bg, fontWeight: active ? 600 : 500, cursor: 'pointer' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = active ? 'color-mix(in srgb, var(--olive) 20%, transparent)' : 'var(--gray-200)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = bg; }}
    >
      {name}
    </button>
  );
}

// Sites an app runs on, from its userscript match patterns (mirrors AppPage).
function appSites(manifest: any): { anyWebsite: boolean; hosts: string[] } | null {
  const scripts = manifest?.userscripts;
  if (!scripts?.length) return null;
  const hosts: string[] = [];
  let anyWebsite = false;
  for (const s of scripts) {
    for (const pattern of (s.matches ?? [])) {
      if (pattern === '<all_urls>') { anyWebsite = true; continue; }
      const host = /^[^:]+:\/\/([^/]+)/.exec(pattern)?.[1];
      if (!host || host === '*') { anyWebsite = true; continue; }
      const clean = host.replace(/^\*\./, '').replace(/^www\./, '');
      if (clean && !hosts.includes(clean)) hosts.push(clean);
    }
  }
  if (anyWebsite) return { anyWebsite: true, hosts: [] };
  return hosts.length ? { anyWebsite: false, hosts } : null;
}

// One-word "where it runs" label for catalog cards: a single brand name
// (LinkedIn, Gmail) or "Multiple" (several sites, or match-all patterns).
const SITE_BRANDS: Record<string, string> = {
  'linkedin.com': 'LinkedIn', 'mail.google.com': 'Gmail', 'calendar.google.com': 'Calendar',
  'x.com': 'X', 'twitter.com': 'X', 'youtube.com': 'YouTube', 'instagram.com': 'Instagram',
  'web.whatsapp.com': 'WhatsApp', 'web.telegram.org': 'Telegram', 'github.com': 'GitHub',
};
function siteWord(matches?: string[]): string | null {
  if (!matches?.length) return null;
  const brands = new Set<string>();
  let any = false;
  for (const pattern of matches) {
    if (pattern === '<all_urls>') { any = true; continue; }
    const host = /^[^:]+:\/\/([^/]+)/.exec(pattern)?.[1];
    if (!host || host === '*') { any = true; continue; }
    const clean = host.replace(/^\*\./, '').replace(/^www\./, '');
    brands.add(SITE_BRANDS[clean] ?? clean);
  }
  if (brands.size > 1) return 'Multiple';
  if (brands.size === 1) return [...brands][0];
  return any ? 'Multiple' : null;
}

// Single source of truth for status-pill colors across the gallery (AppCard),
// the app page header (AppView), and the catalog (CatalogView), so the three
// surfaces never drift. Change a pill's color here once.
const PILL = {
  error: 'var(--error)',          // disabled, missing secrets, server down
  catalog: '#2f6fb3',             // installed-from-catalog provenance + version
  local: '#1d4ed8',               // local-only provenance
  green: '#5f7344',               // installed, modified
  update: 'var(--clay)',          // update available
  neutral: 'var(--fg-tertiary)',  // installed locally
} as const;

const ACTION_TONE = {
  green: 'var(--success)',
  clay: 'var(--clay)',
  danger: 'var(--error)',
  neutral: 'var(--fg-secondary)',
} as const;

// One button for every app action — Enable/Disable/Install render solid,
// Uninstall/Secrets render outline, passive states (catalog "Installed")
// render soft (tinted background, tone-colored text, pill-like). Same height,
// shape, and typography across the gallery, app page, and catalog; callers
// vary only tone, icon, and label.
function ActionButton({
  onClick, disabled, tone, variant = 'solid', icon: Icon, children, testid,
}: {
  onClick?: () => void;
  disabled?: boolean;
  tone: keyof typeof ACTION_TONE;
  variant?: 'solid' | 'outline' | 'soft';
  icon?: React.ComponentType<{ size?: number }>;
  children: React.ReactNode;
  testid?: string;
}) {
  const c = ACTION_TONE[tone];
  const solid = variant === 'solid';
  const baseBg = solid ? c : variant === 'soft' ? `color-mix(in srgb, ${c} 14%, var(--bg-white))` : 'var(--bg-white)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      className="inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-md text-base font-medium border transition-all"
      style={{
        color: solid ? 'var(--bg-white)' : c,
        background: baseBg,
        borderColor: solid ? c : variant === 'soft' ? `color-mix(in srgb, ${c} 35%, var(--bg-white))` : 'var(--border-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        if (solid) e.currentTarget.style.opacity = '0.85';
        else e.currentTarget.style.background = `color-mix(in srgb, ${c} ${variant === 'soft' ? 20 : 8}%, var(--bg-white))`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = disabled ? '0.5' : '1';
        if (!solid) e.currentTarget.style.background = baseBg;
      }}
    >
      {Icon && <Icon size={15} />}
      {children}
    </button>
  );
}

// The app on/off control: a switch shows current state (olive = on, gray =
// off) and affords the flip in one element, so there is no Enable/Disable
// label whose color must be decoded against the card's own state colors.
function ToggleSwitch({ on, onToggle, testid, title }: { on: boolean; onToggle: () => void; testid?: string; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={title}
      title={title}
      data-testid={testid}
      onClick={onToggle}
      className="relative shrink-0 rounded-full cursor-pointer"
      style={{ width: 44, height: 24, background: on ? 'var(--success)' : 'var(--gray-300)', border: 'none', padding: 0, transition: 'background 180ms ease' }}
    >
      <span
        className="absolute rounded-full"
        style={{ width: 18, height: 18, top: 3, left: 3, background: 'var(--bg-white)', transform: on ? 'translateX(20px)' : 'none', boxShadow: '0 1px 2px rgba(0,0,0,0.25)', transition: 'transform 180ms ease' }}
      />
    </button>
  );
}

// The catalog card's button for an up-to-date installed app: a green
// "✓ Installed" at rest that swaps to a red "Uninstall" on hover, so the card
// gets an uninstall affordance without a second destructive button.
function InstalledUninstallButton({ busy, onUninstall, testid }: { busy?: boolean; onUninstall: () => void; testid?: string }) {
  const [hover, setHover] = useState(false);
  return (
    <span className="inline-flex" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {hover || busy
        ? <ActionButton tone="danger" variant="outline" icon={Trash2} disabled={busy} onClick={onUninstall} testid={testid}>{busy ? 'Removing…' : 'Uninstall'}</ActionButton>
        : <ActionButton tone="green" variant="soft" icon={Check} testid={testid}>Installed</ActionButton>}
    </span>
  );
}

// The globe + interpunct-separated host list under an app's description.
function SiteList({ sites, testid }: { sites: NonNullable<ReturnType<typeof appSites>>; testid?: string }) {
  return (
    <div className="mt-2 flex items-center gap-1.5 text-sm" style={{ color: 'var(--fg-tertiary)' }} data-testid={testid}>
      <Globe size={15} />
      {sites.anyWebsite ? <span>Any website</span> : (
        <span className="truncate">
          {sites.hosts.map((h, i) => (<Fragment key={h}>{i > 0 && <span style={{ opacity: 0.45 }}>{' · '}</span>}{h}</Fragment>))}
        </span>
      )}
    </div>
  );
}

// The card for every app in a list — the installed gallery AND the catalog.
// Title, version/status pills, description, and the site list all render here,
// so the two surfaces are identical by construction; callers vary only the
// `pills` and `actions` slots. `onOpen`/`href` make the title + description a
// link (gallery always; catalog only when installed). `drag` carries the DnD.
function AppListCard({
  name, description, sites, sitesTestid, control, pills, metaPills, actions, note, onOpen, href, draggable, drag, testid, dimmed,
}: {
  name: string;
  description?: string;
  sites: ReturnType<typeof appSites>;
  sitesTestid?: string;
  control?: React.ReactNode;
  pills?: React.ReactNode;
  metaPills?: React.ReactNode;
  actions?: React.ReactNode;
  note?: React.ReactNode;
  onOpen?: () => void;
  href?: string;
  draggable?: boolean;
  drag?: React.HTMLAttributes<HTMLDivElement>;
  testid?: string;
  dimmed?: boolean;
}) {
  const open = onOpen ? (e: React.MouseEvent) => { e.preventDefault(); onOpen(); } : undefined;
  // Dimmed (disabled app): muted background, dashed border, no shadow, faded
  // content — but status pills and actions stay full-strength so the state
  // badge and the Enable button remain the loudest things on the card.
  const fade = dimmed ? { opacity: 0.75 } : undefined;
  return (
    <div
      {...drag}
      draggable={draggable}
      data-testid={testid}
      className="rounded-[var(--radius-md)] p-5 transition-all border"
      style={{
        background: dimmed ? 'var(--bg-tertiary)' : 'var(--bg-white)',
        borderColor: dimmed ? 'var(--border-secondary)' : 'var(--border-tertiary)',
        borderStyle: dimmed ? 'dashed' : 'solid',
        boxShadow: dimmed ? 'none' : 'var(--shadow-card)',
        cursor: draggable ? 'grab' : undefined,
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="text-xl font-semibold flex items-center gap-2 flex-wrap" style={{ color: 'var(--fg-primary)' }}>
          {control}
          {open
            ? <a href={href ?? '#'} onClick={open} className="no-underline cursor-pointer" style={{ color: 'inherit', ...fade }}>{name}</a>
            : <span style={fade}>{name}</span>}
          {pills}
        </div>
        {metaPills && <div className="flex items-center gap-1.5 flex-wrap justify-end shrink-0 pt-0.5" style={fade}>{metaPills}</div>}
      </div>
      {description && (open
        ? <a href={href ?? '#'} onClick={open} className="block text-base leading-relaxed no-underline cursor-pointer" style={{ color: 'var(--fg-secondary)', ...fade }}>{description}</a>
        : <div className="text-base leading-relaxed" style={{ color: 'var(--fg-secondary)', ...fade }}>{description}</div>)}
      {sites && <div style={fade}><SiteList sites={sites} testid={sitesTestid} /></div>}
      {note}
      {actions && <div className="flex items-center gap-2 mt-4">{actions}</div>}
    </div>
  );
}

// Catalog card thumbnail: 16:10 static media box — thumbnail image when
// available, the video's first frame as a fallback poster. Apps without media
// get a monogram placeholder so the grid keeps its rhythm.
function MediaThumb({ media, name, onClick, testid }: {
  media?: { video?: string; thumbnail?: string } | null;
  name: string;
  onClick?: () => void;
  testid?: string;
}) {
  return (
    <div
      onClick={onClick}
      className="relative w-full overflow-hidden border"
      style={{
        aspectRatio: '16 / 10',
        borderRadius: 'var(--radius-md)',
        borderColor: 'var(--border-tertiary)',
        background: 'var(--bg-white)',
        boxShadow: 'var(--shadow-card)',
        cursor: onClick ? 'pointer' : undefined,
      }}
      data-testid={testid}
    >
      {media?.video && !media.thumbnail ? (
        <video
          src={media.video}
          muted
          playsInline
          preload="metadata"
          className="w-full h-full object-cover"
        />
      ) : media?.thumbnail ? (
        <img src={media.thumbnail} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center" style={{ background: 'linear-gradient(135deg, var(--gray-150), var(--gray-200))' }}>
          <span className="text-5xl font-semibold select-none" style={{ color: 'var(--fg-tertiary)', opacity: 0.4 }}>{name.charAt(0)}</span>
        </div>
      )}
    </div>
  );
}

// Catalog detail header video: autoplaying loop with a mini control bar —
// play/pause, seek slider, seconds remaining.
function DetailVideo({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Plyr-style countdown: -MM:SS remaining
  const left = Math.max(0, Math.round(duration - time));
  const remaining = `-${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  const fill = duration ? (time / duration) * 100 : 0;
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {}); else v.pause();
  };
  return (
    <div className="relative w-full h-full">
      <video
        ref={ref}
        src={src}
        poster={poster}
        autoPlay
        muted
        loop
        playsInline
        className="w-full h-full object-cover"
        data-testid="catalog-detail-video"
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
      />
      <div
        className="absolute inset-x-0 bottom-0 flex items-center gap-2.5 px-3 pb-2 pt-8"
        style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.55))' }}
      >
        <button
          type="button"
          onClick={toggle}
          className="shrink-0 flex items-center justify-center bg-transparent border-0 p-0 cursor-pointer text-white"
          aria-label={playing ? 'Pause' : 'Play'}
          data-testid="catalog-detail-video-toggle"
        >
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={Math.min(time, duration || 0)}
          onChange={(e) => {
            const v = ref.current;
            if (v) v.currentTime = Number(e.target.value);
          }}
          className="video-range flex-1 min-w-0 cursor-pointer"
          style={{ '--fill': `${fill}%` } as React.CSSProperties}
          aria-label="Seek"
        />
        <span className="shrink-0 text-[13px] font-medium tabular-nums text-white">
          {remaining}
        </span>
      </div>
    </div>
  );
}

// Hosts an app's own UI as a sandboxed iframe and bridges its SDK postMessages
// to the background — the single-shell replacement for the old app-shell.html
// page. The shell stamps the appId it loaded, so the iframe can't spoof another.
// `autoHeight` makes the iframe grow to its content height (it reports height
// via postMessage) so the app scrolls with the dashboard page instead of inside
// a fixed-viewport iframe. It uses flex-grow + shrink:0 so short apps still fill
// the viewport and tall apps overflow into the page scroll.
function AppFrame({ appId, origin, page, autoHeight }: { appId: string; origin: string; page?: string | null; autoHeight?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    setHeight(null);
    const iframe = ref.current;
    if (!iframe) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      const data: any = e.data;
      if (autoHeight && typeof data?._airglow_height === 'number') { setHeight(data._airglow_height); return; }
      // Auto-height apps forward wheel here (the content-sized iframe can't chain
      // it to the page itself); scroll the dashboard, matching the header's scroll.
      if (autoHeight && data?._airglow_wheel) {
        const w = data._airglow_wheel;
        const unit = w.mode === 1 ? 16 : w.mode === 2 ? window.innerHeight : 1;
        window.scrollBy({ left: (w.x || 0) * unit, top: (w.y || 0) * unit });
        return;
      }
      if (!data?._airglow) return;
      chrome.runtime.sendMessage({ ...data, _appId: appId }, (response: any) => {
        const payload = chrome.runtime.lastError
          ? { error: chrome.runtime.lastError.message || 'Chrome runtime message failed', code: 'CHROME_RUNTIME_ERROR' }
          : response || {};
        (e.source as Window | null)?.postMessage({ _airglow_response: true, _callId: data._callId, ...payload }, '*');
      });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [appId, autoHeight]);
  const src = `${origin.replace(/\/+$/, '')}/api/apps/${appId}/ui?app=${encodeURIComponent(appId)}${page ? `&page=${encodeURIComponent(page)}` : ''}${autoHeight ? '&_embed=fit' : ''}`;
  return (
    <iframe
      ref={ref}
      key={appId}
      src={src}
      sandbox="allow-scripts allow-same-origin allow-forms"
      allow="clipboard-read; clipboard-write"
      style={autoHeight
        ? { width: '100%', flex: '1 0 auto', height: height != null ? `${height}px` : undefined, border: 'none', display: 'block' }
        : { width: '100%', height: '100%', border: 'none', display: 'block' }}
      data-testid="app-frame"
    />
  );
}

export default function App() {
  const [page, _setPage] = useState<'apps' | 'logs'>(() => {
    const p = new URLSearchParams(window.location.search).get('page');
    return p === 'logs' ? 'logs' : 'apps';
  });
  function setPage(p: 'apps' | 'logs') {
    _setPage(p);
    const url = new URL(window.location.href);
    if (p === 'apps') url.searchParams.delete('page');
    else url.searchParams.set('page', p);
    history.replaceState(null, '', url.toString());
  }
  const [apps, setApps] = useState<AppManifest[] | null>(null);
  const [error, setError] = useState(false);
  // The native host is macOS/Linux only — on Windows the guide popup shows
  // "not supported" instead of an install command that can't work.
  const [isWindows, setIsWindows] = useState(false);
  useEffect(() => {
    chrome.runtime.getPlatformInfo((info) => setIsWindows(info.os === 'win'));
  }, []);
  // Design preview: ?debug-offline=1 forces the offline state,
  // ?debug-offline=win the Windows variant.
  const debugOffline = new URLSearchParams(window.location.search).get('debug-offline');
  // Dev-guide popup. Auto-opens on startup — offline, Windows, and online
  // alike — until closed once (persisted); the sidebar button reopens it.
  // null = storage not read yet.
  const [guideSeen, setGuideSeen] = useState<boolean | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  // Which guide snippet was just copied ('cmd' | 'prompt'), for the check icon.
  const [guideCopied, setGuideCopied] = useState<string | null>(null);
  function closeGuide() {
    setGuideOpen(false);
    if (!guideSeen) {
      setGuideSeen(true);
      chrome.storage.local.set({ [DEV_GUIDE_SEEN_KEY]: true });
    }
  }
  function copyGuide(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setGuideCopied(key);
      setTimeout(() => setGuideCopied(null), 1500);
    });
  }
  const [disabledApps, setDisabledApps] = useState<Set<string>>(new Set());
  const [localOnline, setLocalOnline] = useState<boolean | null>(null);
  // Problem surfaced on the sidebar dev button (red "Start Daemon" when the
  // daemon is offline) and explained inside its popup. Windows (host
  // unsupported) beats offline. Live: the background poll flips
  // __dev_server_online → loadAll re-runs → the popup's red banner swaps to
  // the guide steps the moment the host comes up.
  const offlineIsWindows = isWindows || debugOffline === 'win';
  const devIssue: 'windows' | 'offline' | null =
    offlineIsWindows ? 'windows'
      : (error || localOnline === false || debugOffline !== null) ? 'offline'
      : null;
  // null = checking; true/false = cloud /api/healthz reachability.
  const [cloudOnline, setCloudOnline] = useState<boolean | null>(null);
  // null = not yet known; true/false = native host liveness.
  const [nativeHostConnected, setNativeHostConnected] = useState<boolean | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [unseenErrorCount, setUnseenErrorCount] = useState(0);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // Apps view: Installed | Catalog
  // Both the tab and the open detail page live in the URL (?page=catalog,
  // ?catalogApp=<id>) so F5 and copied links restore the same view.
  const [activeTab, setActiveTab] = useState<'installed' | 'catalog'>(
    () => new URLSearchParams(window.location.search).get('page') === 'catalog' ? 'catalog' : 'installed',
  );
  const [catalogApps, setCatalogApps] = useState<CatalogApp[] | null>(null);
  // Catalog detail page (card click) — an app id, or null for the grid.
  const [catalogOpenId, setCatalogOpenId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('catalogApp'),
  );
  const [provenance, setProvenance] = useState<Record<string, Provenance>>({});
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  // App pending uninstall confirmation (native in-page modal, not window.confirm).
  const [confirmUninstall, setConfirmUninstall] = useState<AppManifest | null>(null);
  // Transient top-of-page notice (e.g. "host offline" on a failed uninstall).
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showNotice(msg: string) {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }
  const [showHostPopup, setShowHostPopup] = useState(false);
  const [hostCmdCopied, setHostCmdCopied] = useState(false);
  const [daemonDisabled, setDaemonDisabled] = useState(false);

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Active inline setup banner ('pin' | null) reported by SetupBanners, and a
  // staged extension update (null when up to date). The pin banner renders as a
  // centered card; the update version drives the "Update" button by the version.
  const [dashSetup, setDashSetup] = useState<SetupStep | null>(null);
  const extUpdate = useExtUpdateAvailable();
  const hostVersion = useHostVersion();
  const [sideButtonEnabled, setSideButtonEnabled] = useState(false);
  const [sidepanelEnabled, setSidepanelEnabled] = useState(false);
  const [gatewayUrlInput, setGatewayUrlInput] = useState('');
  // Host self-update state (Settings modal). null = not yet checked.
  const [hostUpdate, setHostUpdate] = useState<{
    current: string; latest: string | null; updateAvailable: boolean; mode: string; updating?: boolean;
  } | null>(null);
  const [hostUpdating, setHostUpdating] = useState(false);
  const [hostUpdateError, setHostUpdateError] = useState<string | null>(null);
  // Version just installed via the Update button — shows a brief confirmation
  // where the button was (it otherwise vanishes with no feedback).
  const [hostUpdated, setHostUpdated] = useState<string | null>(null);

  // Connected accounts (third-party tool connections, scoped per app).
  // Loaded from the daemon when Settings opens.
  const [connAccounts, setConnAccounts] = useState<ConnectedAccount[] | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [connRemoving, setConnRemoving] = useState<string | null>(null);

  // Secrets state. Per-app: the daemon stores UI-entered values per app
  // (highest precedence), .env files are the developer-level fallback.
  // Inputs/visibility are keyed by `${appId}:${key}`.
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [envApps, setEnvApps] = useState<AppEnvStatus[]>([]);
  const [envInputs, setEnvInputs] = useState<Record<string, string>>({});
  const [envVisible, setEnvVisible] = useState<Record<string, boolean>>({});
  const [envSaving, setEnvSaving] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  // Secrets are managed per app — the modal is scoped to a single app, opened
  // from its card. null = closed.
  const [secretsApp, setSecretsApp] = useState<string | null>(null);

  // Single shell: an app's own UI loads as a sandboxed iframe in the content
  // area (no separate tab). openAppId !== null → the app view is showing.
  const [openAppId, setOpenAppId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('app'),
  );
  // App sub-page (e.g. an app's "chat" view) forwarded to its UI iframe as
  // ?page=. `chromeless` (set by openApp({ window: true })) renders just the app
  // frame as a focused popup — no sidebar/header.
  const [appPage, setAppPage] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('appPage'),
  );
  const chromeless = new URLSearchParams(window.location.search).get('chromeless') === '1';
  const [daemonOriginUrl, setDaemonOriginUrl] = useState('');
  useEffect(() => { getDaemonOrigin().then(setDaemonOriginUrl).catch(() => {}); }, []);

  // Navigate to an app's page in-place (or back to a list view with null).
  function openApp(appId: string | null) {
    setOpenAppId(appId);
    setAppPage(null);
    setCatalogOpenId(null);
    if (appId) _setPage('apps');
    const url = new URL(window.location.href);
    // Keep ?page=catalog when closing an app back onto the catalog tab, so a
    // reload still lands there; anything else (logs/settings) clears.
    if (!appId && activeTab === 'catalog') url.searchParams.set('page', 'catalog');
    else url.searchParams.delete('page');
    url.searchParams.delete('appPage');
    url.searchParams.delete('catalogApp');
    if (appId) url.searchParams.set('app', appId);
    else url.searchParams.delete('app');
    history.replaceState(null, '', url.toString());
  }

  // Switch the Installed/Catalog tab, stamped in the URL (?page=catalog).
  function setTab(tab: 'installed' | 'catalog') {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    if (tab === 'catalog') url.searchParams.set('page', 'catalog');
    else url.searchParams.delete('page');
    history.replaceState(null, '', url.toString());
  }

  // Open/close the catalog detail page, mirrored in the URL (?catalogApp=).
  function openCatalogApp(id: string | null) {
    setCatalogOpenId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('catalogApp', id);
    else url.searchParams.delete('catalogApp');
    history.replaceState(null, '', url.toString());
  }

  // Honor ?page= for cross-surface navigation from an app page's sidebar
  // (Catalog / Settings; logs/apps are handled by the page initializer).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('page');
    if (p === 'catalog') { void loadCatalog(); }
    else if (p === 'settings') { setSettingsOpen(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closeable "dev server offline — running from cache" banner. Dismissal is
  // session-scoped: comes back on the next dashboard open so the user notices
  // again if the server is still down, but stays quiet within a session.

  // Drag-and-drop reorder
  const [appOrder, setAppOrder] = useState<Record<string, string[]>>({});
  const dragItem = useRef<{ section: string; index: number } | null>(null);
  const dragOverItem = useRef<{ section: string; index: number } | null>(null);
  const dashboardOpenTracked = useRef(false);

  function sortByOrder(list: AppManifest[], section: string): AppManifest[] {
    const order = appOrder[section];
    if (!order) return list;
    const idxMap = new Map(order.map((id, i) => [id, i]));
    return [...list].sort((a, b) => {
      const ai = idxMap.get(a.id) ?? -1;
      const bi = idxMap.get(b.id) ?? -1;
      return ai - bi;
    });
  }

  function handleDragStart(section: string, index: number) {
    dragItem.current = { section, index };
  }

  function handleDragEnter(section: string, index: number) {
    dragOverItem.current = { section, index };
  }

  function handleDragEnd(list: AppManifest[], section: string) {
    if (!dragItem.current || !dragOverItem.current) return;
    if (dragItem.current.section !== dragOverItem.current.section) return;
    if (dragItem.current.section !== section) return;

    const sorted = sortByOrder(list, section);
    const reordered = [...sorted];
    const [removed] = reordered.splice(dragItem.current.index, 1);
    reordered.splice(dragOverItem.current.index, 0, removed);

    const newOrder = { ...appOrder, [section]: reordered.map(a => a.id) };
    setAppOrder(newOrder);
    chrome.storage.local.set({ [APP_ORDER_KEY]: newOrder });

    dragItem.current = null;
    dragOverItem.current = null;
  }

  async function loadAll() {
    // The background loader polls the daemon and persists the manifest list.
    // Read the daemon-online flag and the list in one round-trip instead of
    // re-fetching manifests ourselves.
    const [stored, manifestRes] = await Promise.all([
      chrome.storage.local.get('__dev_server_online'),
      chrome.runtime.sendMessage({ type: 'airglow:get-dashboard-manifests' }).catch(() => null),
    ]);
    const manifests: AppManifest[] = Array.isArray(manifestRes?.manifests) ? manifestRes.manifests : [];
    const online = Boolean(stored['__dev_server_online']);

    setLocalOnline(online);
    setError(!online && manifests.length === 0);
    setApps(manifests.filter(isVisibleApp));

    loadEnvStatus();
    void loadCatalog();
  }

  function loadEnvStatus() {
    void (async () => {
      try {
        if ((await chrome.storage.local.get(DAEMON_DISABLED_KEY))[DAEMON_DISABLED_KEY]) {
          setEnvApps([]);
          setEnvError(null);
          return;
        }
        const origin = await getDaemonOrigin();
        const res = await fetch(`${origin}/api/env/status`);
        const data = await res.json();
        if (Array.isArray(data?.apps)) {
          setEnvApps(data.apps);
          setEnvError(null);
        }
      } catch {
        setEnvError('Could not reach the Airglow daemon — is it running?');
      }
    })();
  }

  // Catalog index (from the cloud) + install provenance (from the daemon).
  async function loadCatalog() {
    try {
      const cloud = await getCloudApiUrl();
      // 'no-cache' revalidates past the browser HTTP cache — the route's
      // max-age=60 + stale-while-revalidate otherwise serves a minutes-old
      // copy on refresh. Prod still gets the CDN cache server-side.
      const res = await fetch(`${cloud}/api/catalog`, { cache: 'no-cache' });
      const data = await res.json();
      if (Array.isArray(data?.apps)) setCatalogApps(data.apps);
    } catch { setCatalogApps([]); }
    await loadProvenance();
  }

  async function loadProvenance() {
    try {
      if ((await chrome.storage.local.get(DAEMON_DISABLED_KEY))[DAEMON_DISABLED_KEY]) {
        setProvenance({});
        return;
      }
      const origin = await getDaemonOrigin();
      const res = await fetch(`${origin}/api/catalog/installed`);
      const data = await res.json();
      if (data?.provenance) setProvenance(data.provenance);
    } catch { /* daemon down — handled elsewhere */ }
  }

  // Install target: daemon when the app needs the host, a daemon copy is
  // being replaced/updated (a local copy shadows the cloud one, so a cloud
  // install would be invisible), or the user asked for the source locally
  // ("Edit locally"); cloud otherwise — works with no host at all.
  async function installCatalogApp(appId: string, opts?: { daemon?: boolean }) {
    const entry = catalogApps?.find((c) => c.id === appId);
    const daemonOwned = Boolean(provenance[appId]) || (apps || []).some(
      (a) => a.id === appId && a._sourceType !== 'cloud',
    );
    const viaDaemon = opts?.daemon || entry?.requiresHost || daemonOwned;
    setInstalling(appId);
    try {
      if (viaDaemon) {
        const origin = await getDaemonOrigin();
        const res = await fetch(`${origin}/api/catalog/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || 'install failed');
      } else {
        const session = await getStoredSession();
        if (!session?.token) throw new Error('Sign in first (Settings → Account)');
        const cloud = await getCloudApiUrl();
        const res = await fetch(`${cloud}/api/apps/install`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Airglow-App-Id': 'airglow-extension',
            Authorization: `Bearer ${session.token}`,
          },
          body: JSON.stringify({ appId }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error?.message || 'install failed');
      }
      // loadAll() reads the background loader's cached manifest list, which
      // only refreshes on a 5s poll. Force an immediate re-fetch first, else
      // the just-installed app is absent on the first click and only appears
      // after the next poll tick (the "have to click Install twice" bug).
      await chrome.runtime.sendMessage({ type: 'airglow:reload-apps' }).catch(() => null);
      await loadAll();
      await loadCatalog();
    } catch (e) {
      alert(`Install failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setInstalling(null);
    }
  }

  // Uninstall follows the app's source: cloud installs flip the account
  // record; daemon installs delete the app's folder + sidecars (provenance,
  // secrets). The opener just surfaces the in-page confirm modal.
  async function performUninstall(app: AppManifest) {
    setConfirmUninstall(null);
    setUninstalling(app.id);
    try {
      if (app._sourceType === 'cloud') {
        const session = await getStoredSession();
        if (!session?.token) throw new Error('Sign in first (Settings → Account)');
        const cloud = await getCloudApiUrl();
        const res = await fetch(`${cloud}/api/apps/uninstall`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Airglow-App-Id': 'airglow-extension',
            Authorization: `Bearer ${session.token}`,
          },
          body: JSON.stringify({ appId: app.id }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error?.message || 'uninstall failed');
      } else {
        const origin = await getDaemonOrigin();
        let res: Response;
        try {
          res = await fetch(`${origin}/api/apps/uninstall`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId: app.id }),
          });
        } catch {
          // Daemon unreachable — local apps can only be uninstalled by the
          // daemon (it owns the folder + sidecars). Surface a notice instead
          // of the generic "Failed to fetch" alert.
          showNotice('Host offline — start the Airglow host to uninstall local apps.');
          return;
        }
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || 'uninstall failed');
      }
      // Force an immediate manifest re-fetch (same as install) so the removed
      // app disappears now instead of after the next 5s background poll.
      await chrome.runtime.sendMessage({ type: 'airglow:reload-apps' }).catch(() => null);
      await loadAll();
    } catch (e) {
      alert(`Uninstall failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setUninstalling(null);
    }
  }

  useEffect(() => {
    let lastSeen = 0;
    let cancelled = false;

    function recompute() {
      chrome.runtime.sendMessage({ type: 'airglow:logs:get' }, (res) => {
        if (cancelled || !res?.entries) return;
        const count = (res.entries as Array<{ ts: number; level: string }>)
          .reduce((n, e) => (e.level === 'error' && e.ts > lastSeen ? n + 1 : n), 0);
        setUnseenErrorCount(count);
      });
    }

    chrome.storage.local.get(LOGS_LAST_SEEN_KEY, (res: Record<string, any>) => {
      lastSeen = (res[LOGS_LAST_SEEN_KEY] as number | undefined) ?? 0;
      recompute();
    });

    const id = setInterval(recompute, 3000);
    const storageListener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (LOGS_LAST_SEEN_KEY in changes) {
        lastSeen = (changes[LOGS_LAST_SEEN_KEY].newValue as number | undefined) ?? 0;
        recompute();
      }
    };
    chrome.storage.local.onChanged.addListener(storageListener);

    return () => {
      cancelled = true;
      clearInterval(id);
      chrome.storage.local.onChanged.removeListener(storageListener);
    };
  }, []);

  useEffect(() => {
    chrome.storage.local.get(['__disabled_apps', APP_ORDER_KEY, '__native_host_connected', SIDE_BUTTON_KEY, SIDEPANEL_KEY, CLOUD_API_URL_OVERRIDE_KEY, DAEMON_DISABLED_KEY, DEV_GUIDE_SEEN_KEY], (result) => {
      const nh = result['__native_host_connected'];
      setNativeHostConnected(nh === undefined ? null : (nh as boolean));
      setDisabledApps(new Set((result['__disabled_apps'] || []) as string[]));
      if (result[APP_ORDER_KEY]) setAppOrder(result[APP_ORDER_KEY] as unknown as Record<string, string[]>);
      setSideButtonEnabled(!!result[SIDE_BUTTON_KEY]);
      setSidepanelEnabled(!!result[SIDEPANEL_KEY]);
      setDaemonDisabled(!!result[DAEMON_DISABLED_KEY]);
      setGuideSeen(!!result[DEV_GUIDE_SEEN_KEY]);
      setGatewayUrlInput(typeof result[CLOUD_API_URL_OVERRIDE_KEY] === 'string' ? result[CLOUD_API_URL_OVERRIDE_KEY] : '');
      getStoredSession().then((session) => {
        setAuthSession(session);
        setIdentityLoaded(true);
        loadAll();
      });
    });

    // Background polls the daemon every few seconds and writes the result
    // to __dev_server_online — react to transitions so the dashboard updates
    // live (no manual reload needed when the daemon comes back).
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('__dev_server_online' in changes || '__app_manifests' in changes) {
        loadAll();
      }
      if (AUTH_SESSION_KEY in changes) {
        getStoredSession().then(setAuthSession);
      }
      if ('__native_host_connected' in changes) {
        const v = changes['__native_host_connected'].newValue;
        setNativeHostConnected(v === undefined ? null : (v as boolean));
      }
      // Side-button toggles write here too. Mirror into dashboard state so
      // both UIs agree without requiring a dashboard reload.
      if ('__disabled_apps' in changes) {
        const arr = (changes['__disabled_apps'].newValue as string[] | undefined) || [];
        setDisabledApps(new Set(arr));
      }
      if (SIDE_BUTTON_KEY in changes) {
        setSideButtonEnabled(!!changes[SIDE_BUTTON_KEY].newValue);
      }
      if (SIDEPANEL_KEY in changes) {
        setSidepanelEnabled(!!changes[SIDEPANEL_KEY].newValue);
      }
      if (DAEMON_DISABLED_KEY in changes) {
        setDaemonDisabled(!!changes[DAEMON_DISABLED_KEY].newValue);
      }
    };
    chrome.storage.local.onChanged.addListener(onChange);
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, []);

  // Auto-open the "Develop apps" guide on startup once the app list settles —
  // offline and Windows included (the popup then leads with the problem
  // callout). Waits out the pin nag; closing marks it seen (persisted) so it
  // stops auto-opening.
  useEffect(() => {
    if (guideSeen === false && authSession && page === 'apps' && !openAppId && !chromeless && dashSetup !== 'pin' && apps !== null) {
      setGuideOpen(true);
    }
  }, [guideSeen, authSession, page, openAppId, dashSetup, apps]);

  useEffect(() => {
    if (!identityLoaded || dashboardOpenTracked.current) return;
    dashboardOpenTracked.current = true;
    chrome.runtime.sendMessage({
      type: 'airglow:track-dashboard-opened',
      page,
    }, () => { void chrome.runtime.lastError; });
  }, [identityLoaded, page]);

  // An app's UI became visible — in-shell navigation, ?app= deep link, and
  // chromeless popups all funnel through openAppId.
  useEffect(() => {
    if (!openAppId) return;
    chrome.runtime.sendMessage({
      type: 'airglow:track-ui-page-opened',
      appId: openAppId,
    }, () => { void chrome.runtime.lastError; });
  }, [openAppId]);

  // Probe the cloud's /api/healthz so the sidebar can show whether it's
  // reachable. Re-runs (debounced) whenever the resolved URL changes — e.g.
  // editing the override in Settings — and polls periodically to catch the
  // server going up/down. Keyed on the same value the sidebar renders.
  const cloudApiUrl = gatewayUrlInput.trim() || getDefaultCloudApiUrl();
  useEffect(() => {
    let cancelled = false;
    setCloudOnline(null);
    const probe = async () => {
      const ok = await checkCloudApiReachable(cloudApiUrl);
      if (!cancelled) setCloudOnline(ok);
    };
    const debounce = setTimeout(probe, 400);
    const poll = setInterval(probe, 30000);
    return () => { cancelled = true; clearTimeout(debounce); clearInterval(poll); };
  }, [cloudApiUrl]);

  function setSideButton(next: boolean) {
    setSideButtonEnabled(next);
    chrome.storage.local.set({ [SIDE_BUTTON_KEY]: next });
  }

  function setSidepanel(next: boolean) {
    setSidepanelEnabled(next);
    chrome.storage.local.set({ [SIDEPANEL_KEY]: next });
  }

  async function setDaemonDisabledFlag(next: boolean) {
    setDaemonDisabled(next);
    await chrome.storage.local.set({ [DAEMON_DISABLED_KEY]: next });
    // The background reloads the merged app set on this key's change; refresh
    // the dashboard's daemon-derived state immediately rather than on its poll.
    await chrome.runtime.sendMessage({ type: 'airglow:reload-apps' }).catch(() => null);
    await loadAll();
  }

  function saveGatewayUrl() {
    const trimmed = gatewayUrlInput.trim();
    if (trimmed && !/^https?:\/\//.test(trimmed)) return; // background/daemon ignore invalid anyway
    chrome.storage.local.set({ [CLOUD_API_URL_OVERRIDE_KEY]: trimmed });
  }

  async function daemonOrigin(): Promise<string | null> {
    const r = await chrome.storage.local.get('__daemon_origin');
    return typeof r['__daemon_origin'] === 'string' ? r['__daemon_origin'] : null;
  }

  async function loadConnectedAccounts() {
    const origin = await daemonOrigin();
    if (!origin) { setConnAccounts(null); return; }
    try {
      const res = await fetch(`${origin}/api/connectors/accounts`);
      const body = await res.json();
      if (Array.isArray(body?.accounts)) {
        setConnAccounts(body.accounts);
        setConnError(null);
      } else if (body?.code === 'CONNECTOR_NO_API_KEY') {
        setConnAccounts([]);
        setConnError(null);
      } else {
        setConnError(String(body?.error ?? 'could not load connected accounts'));
      }
    } catch {
      setConnAccounts(null); // daemon offline — row shows nothing useful
    }
  }

  async function removeConnectedAccount(id: string) {
    const origin = await daemonOrigin();
    if (!origin) return;
    setConnRemoving(id);
    try {
      await fetch(`${origin}/api/connectors/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadConnectedAccounts();
    } catch {
      setConnError('could not remove the connection');
    } finally {
      setConnRemoving(null);
    }
  }

  // Check host version/update availability when Settings opens.
  useEffect(() => {
    if (!settingsOpen) return;
    setHostUpdateError(null);
    void loadConnectedAccounts();
    daemonOrigin().then(async (origin) => {
      if (!origin) { setHostUpdate(null); return; }
      try {
        const res = await fetch(`${origin}/api/daemon/update-check`);
        const body = await res.json();
        if (body?.ok) setHostUpdate(body);
        else setHostUpdateError(String(body?.error ?? 'update check failed'));
      } catch {
        setHostUpdate(null); // daemon offline — row shows nothing useful
      }
    });
  }, [settingsOpen]);

  // Surface host updates in the sidebar without opening Settings: check when
  // the dashboard opens (and when the daemon comes online), then re-check
  // hourly while the page stays open.
  useEffect(() => {
    if (!localOnline) return;
    let cancelled = false;
    const check = async () => {
      const origin = await daemonOrigin();
      if (!origin || cancelled) return;
      try {
        const res = await fetch(`${origin}/api/daemon/update-check`);
        const body = await res.json();
        if (!cancelled && body?.ok) {
          setHostUpdate(body);
          // An update started before this page loaded (e.g. the user refreshed
          // mid-"Updating…") — resume the waiting UI instead of showing nothing.
          if (body.updating && body.latest) {
            setHostUpdating(true);
            awaitHostUpdated(body.latest, origin).catch((e) => {
              setHostUpdateError(e instanceof Error ? e.message : String(e));
              setHostUpdating(false);
            });
          }
        }
      } catch {}
    };
    void check();
    const t = setInterval(check, 60 * 60 * 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, [localOnline]);

  // The daemon swaps its binary and restarts; poll until the new version
  // answers (the port may change across the restart, so re-read origin), then
  // flip the UI to "updated". Throws if it never comes back.
  async function awaitHostUpdated(target: string, origin: string) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const o = (await daemonOrigin()) ?? origin;
        const s = await fetch(`${o}/api/healthz`).then((r) => r.json());
        if (s?.version === target) {
          setHostUpdate({ current: target, latest: target, updateAvailable: false, mode: 'binary' });
          setHostUpdating(false);
          setHostUpdated(target);
          setTimeout(() => setHostUpdated(null), 12_000);
          // Poke useHostVersion so the sidebar version line refreshes now
          // instead of on its 15s poll.
          void chrome.storage.local.set({ __host_version_poke: Date.now() });
          return;
        }
      } catch {}
    }
    throw new Error('daemon did not come back — check state/daemon.log');
  }

  async function updateHost() {
    const origin = await daemonOrigin();
    if (!origin || !hostUpdate?.latest) return;
    setHostUpdating(true);
    setHostUpdateError(null);
    try {
      const res = await fetch(`${origin}/api/daemon/update`, { method: 'POST' });
      const body = await res.json();
      if (!body?.ok) throw new Error(String(body?.error ?? `daemon responded ${res.status}`));
      await awaitHostUpdated(body.updatingTo, origin);
    } catch (e) {
      setHostUpdateError(e instanceof Error ? e.message : String(e));
      setHostUpdating(false);
    }
  }

  async function startGoogleSignIn() {
    if (signingIn) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const session = await signInWithGoogle({ interactive: true });
      setAuthSession(session);
    } catch (e) {
      if (e instanceof AuthCancelledError) return; // user closed the picker — not an error
      setSignInError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningIn(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    setAuthSession(null);
  }

  function toggleApp(appId: string) {
    // Optimistic UI; storage listener below reconciles from the authoritative
    // disabled set once the background has written it.
    const wasDisabled = disabledApps.has(appId);
    const next = new Set(disabledApps);
    if (wasDisabled) next.delete(appId);
    else next.add(appId);
    setDisabledApps(next);
    // Delegate to the same path the side-button toggle uses: the background
    // writes __disabled_apps, unregisters scripts when transitioning to
    // disabled, and re-registers the rest. Previously the dashboard wrote
    // storage itself and called reload-app, which early-returned in the
    // "now-disabled" case and left the userscript registered.
    chrome.runtime.sendMessage({ type: 'airglow:toggle-app', appId });
  }

  function appUrl(appId: string) {
    // Single shell: an app's URL is the dashboard with that app selected.
    return chrome.runtime.getURL(`dashboard.html?app=${appId}`);
  }

  // ── Secrets modal ──

  // Secrets are per app — opened from a specific app's card.
  function openSecrets(appId: string) {
    setSecretsApp(appId);
    setEnvInputs({});
    setEnvVisible({});
    loadEnvStatus();
    setSecretsOpen(true);
  }

  // Eye toggle in the secrets modal. Revealing a set key with nothing typed
  // pulls the stored value in so it's viewable.
  async function revealEnv(appId: string, key: string, isSet: boolean) {
    const inputKey = `${appId}:${key}`;
    const turningOn = !envVisible[inputKey];
    setEnvVisible((prev) => ({ ...prev, [inputKey]: turningOn }));
    if (!turningOn || envInputs[inputKey] || !isSet) return;
    try {
      const origin = await getDaemonOrigin();
      const res = await fetch(`${origin}/api/env/reveal?appId=${encodeURIComponent(appId)}&key=${encodeURIComponent(key)}`);
      const data = await res.json();
      if (data?.value) setEnvInputs((prev) => ({ ...prev, [inputKey]: data.value }));
    } catch { /* leave masked */ }
  }

  // Push one app's entries to the daemon's UI secret store ('' deletes a
  // key). Effective on the next RPC call — no restart.
  async function postEnv(appId: string, entries: Record<string, string>) {
    setEnvSaving(true);
    try {
      const origin = await getDaemonOrigin();
      const res = await fetch(`${origin}/api/env/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, entries }),
      });
      const data = await res.json();
      if (Array.isArray(data?.apps)) setEnvApps(data.apps);
      setEnvInputs((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(entries)) delete next[`${appId}:${key}`];
        return next;
      });
      setEnvError(null);
    } catch {
      setEnvError('Could not reach the Airglow daemon — is it running?');
    }
    setEnvSaving(false);
  }

  function saveSecrets() {
    for (const a of envApps) {
      const entries: Record<string, string> = {};
      for (const k of a.keys) {
        const v = (envInputs[`${a.appId}:${k.key}`] || '').trim();
        if (v) entries[k.key] = v;
      }
      if (Object.keys(entries).length > 0) void postEnv(a.appId, entries);
    }
  }

  function getMissingSecrets(app: Pick<AppManifest, 'id'>): string[] {
    const status = envApps.find((a) => a.appId === app.id);
    if (!status) return [];
    return status.keys.filter((k) => !k.set).map((k) => `${k.label || k.key} (${k.key})`);
  }

  // Unsaved input present?
  const secretsChanged = Object.values(envInputs).some((v) => v.trim());

  // `solid` renders a filled pill (white text on the tone color) for states
  // that must read at a glance even on a dimmed card — e.g. Disabled.
  function Badge({ children, color, hoverable, solid }: { children: React.ReactNode; color: string; hoverable?: boolean; solid?: boolean }) {
    return (
      <span
        className={`text-sm font-medium px-1.5 py-0.5 rounded${hoverable ? ' cursor-help' : ''}`}
        style={solid ? {
          background: color,
          color: 'var(--bg-white)',
          border: `1px solid ${color}`,
        } : {
          background: `color-mix(in srgb, ${color} 12%, transparent)`,
          color,
          border: `1px solid color-mix(in srgb, ${color} 55%, transparent)`,
        }}
      >
        {children}
      </span>
    );
  }

  function Tooltip({ children, content }: { children: React.ReactNode; content: React.ReactNode }) {
    const [show, setShow] = useState(false);
    // Anchor coords in viewport space; the tip is portaled to <body> with
    // position:fixed so no overflow/stacking-context ancestor can clip it.
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const ref = useRef<HTMLSpanElement>(null);
    const tipRef = useRef<HTMLSpanElement>(null);

    const open = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left + r.width / 2, top: r.top });
      setShow(true);
    };
    // Close immediately on leave; the tip is non-interactive so it must not
    // linger or be hoverable once the pointer leaves the trigger.
    const close = () => setShow(false);

    // Once the tip has measured, clamp it horizontally into the viewport.
    useLayoutEffect(() => {
      if (!show || !pos || !tipRef.current) return;
      const half = tipRef.current.offsetWidth / 2;
      const margin = 8;
      const min = margin + half;
      const max = window.innerWidth - margin - half;
      const clamped = Math.min(Math.max(pos.left, min), max);
      if (Math.abs(clamped - pos.left) > 0.5) setPos((p) => (p ? { ...p, left: clamped } : p));
    }, [show, pos?.left, pos?.top]);

    return (
      <span
        ref={ref}
        className="inline-flex"
        onMouseEnter={open}
        onMouseLeave={close}
      >
        {children}
        {show && pos && createPortal(
          <span
            ref={tipRef}
            className="fixed -translate-x-1/2 -translate-y-full px-3 py-2 text-base rounded-md border font-normal pointer-events-none"
            style={{ left: pos.left, top: pos.top - 6, zIndex: 9999, background: 'var(--bg-white)', color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', whiteSpace: 'nowrap' }}
          >
            {content}
          </span>,
          document.body,
        )}
      </span>
    );
  }

  function AppCard({ app, section, index, list }: { app: AppManifest; section?: string; index?: number; list?: AppManifest[] }) {
    const disabled = disabledApps.has(app.id);
    const missing = getMissingSecrets(app);
    const hasSecrets = (envApps.find((a) => a.appId === app.id)?.keys.length ?? 0) > 0;
    const sites = appSites(app);
    const prov = provenance[app.id];
    const catalogEntry = catalogApps?.find((c) => c.id === app.id);
    const updateAvailable = !!(prov && catalogEntry && app.version && isNewerVersion(catalogEntry.version, app.version));
    const isDraggable = section !== undefined && index !== undefined && list !== undefined;
    return (
      <AppListCard
        name={app.name}
        description={app.description}
        sites={sites}
        sitesTestid={`app-sites-${app.id}`}
        dimmed={disabled}
        control={<ToggleSwitch on={!disabled} onToggle={() => toggleApp(app.id)} title={disabled ? 'Enable' : 'Disable'} testid={`app-toggle-${app.id}`} />}
        onOpen={() => openApp(app.id)}
        href={appUrl(app.id)}
        draggable={isDraggable}
        drag={isDraggable ? {
          onDragStart: () => handleDragStart(section, index),
          onDragEnter: () => handleDragEnter(section, index),
          onDragEnd: () => handleDragEnd(list, section),
          onDragOver: (e) => e.preventDefault(),
        } : undefined}
        pills={<>
          {disabled && <Badge color={PILL.error} solid>Disabled</Badge>}
          {!disabled && missing.length > 0 && (
            <span onClick={() => openSecrets(app.id)} className="cursor-pointer" data-testid={`app-missing-secrets-${app.id}`}>
              <Tooltip content={<span><strong>Missing secrets — click to set:</strong><br/>{missing.map(m => <span key={m}>&nbsp;&bull; {m}<br/></span>)}</span>}>
                <Badge color={PILL.error} hoverable solid>
                  {missing.length} secret{missing.length > 1 ? 's' : ''} missing
                </Badge>
              </Tooltip>
            </span>
          )}
          {!disabled && localOnline === false && (app._serverFunctions?.length ?? 0) > 0 && (
            <Tooltip content={<span>This app may break when Dev server is down.</span>}>
              <Badge color={PILL.error} hoverable>Server down</Badge>
            </Tooltip>
          )}
        </>}
        metaPills={<>
          {prov || app._sourceType === 'cloud' ? (
            <Tooltip content={<span>Installed from the catalog{app.version ? ` (v${app.version})` : ''}.</span>}>
              <Badge color={PILL.catalog} hoverable>Catalog{app.version ? ` · v${app.version}` : ''}</Badge>
            </Tooltip>
          ) : (
            <Tooltip content={<span>Lives only in your local workspace — not installed from the catalog.</span>}>
              <Badge color={PILL.local} hoverable>Local</Badge>
            </Tooltip>
          )}
          {updateAvailable && (
            <Tooltip content={<span>A newer version (v{catalogEntry!.version}) is in the catalog. Reinstall from the Catalog tab to update.</span>}>
              <Badge color={PILL.update} hoverable>Update → v{catalogEntry!.version}</Badge>
            </Tooltip>
          )}
          {prov?.modified && (
            <Tooltip content={<span>This catalog app has local edits since it was installed.</span>}>
              <Badge color={PILL.green} hoverable>Modified</Badge>
            </Tooltip>
          )}
        </>}
        actions={<>
          <ActionButton tone="danger" variant="outline" icon={Trash2} disabled={uninstalling === app.id} onClick={() => setConfirmUninstall(app)}>
            {uninstalling === app.id ? 'Removing…' : 'Uninstall'}
          </ActionButton>
          {hasSecrets && (
            <ActionButton tone="neutral" variant="outline" icon={KeyRound} onClick={() => openSecrets(app.id)} testid={`app-secrets-${app.id}`}>
              Secrets
            </ActionButton>
          )}
          {app._sourceType === 'cloud' && localOnline && (
            <Tooltip content={<span>Copies the source into ~/.airglow/apps — your local copy then serves the app.</span>}>
              <ActionButton
                tone="neutral"
                variant="outline"
                icon={Download}
                disabled={installing === app.id}
                onClick={() => installCatalogApp(app.id, { daemon: true })}
                testid={`edit-locally-${app.id}`}
              >
                Edit locally
              </ActionButton>
            </Tooltip>
          )}
        </>}
      />
    );
  }

  // Shared install/lifecycle state for one catalog entry — computed the same
  // way for the grid card and the detail page so the two never disagree.
  function catalogFlags(c: CatalogApp) {
    const installedApp = (apps || []).find((a) => a.id === c.id);
    const installed = !!installedApp;
    const cloudInstalled = installedApp?._sourceType === 'cloud';
    const fromCatalog = !!provenance[c.id] || cloudInstalled;
    const updatable = installed && !cloudInstalled && !!installedApp?.version && isNewerVersion(c.version, installedApp.version);
    return {
      installedApp, installed, cloudInstalled, fromCatalog, updatable,
      busy: installing === c.id,
      installedDone: installed && fromCatalog && !updatable,
      hostMissing: !!c.requiresHost && !localOnline,
    };
  }

  // The chip shown instead of Install when an app needs the (absent) host.
  function HostRequiredChip({ testid }: { testid?: string }) {
    return (
      <span
        className="inline-flex items-center h-9 px-3 rounded-md text-sm font-medium whitespace-nowrap"
        style={{ color: '#5f7344', background: 'color-mix(in srgb, #5f7344 12%, var(--bg-white))', border: '1px solid color-mix(in srgb, #5f7344 35%, var(--bg-white))' }}
        data-testid={testid}
      >
        Host required
      </span>
    );
  }

  // The primary action for a catalog entry: Install / Update / Replace, or the
  // hover-to-uninstall "Installed" state once the catalog version is in place.
  function CatalogAction({ c, f }: { c: CatalogApp; f: ReturnType<typeof catalogFlags> }) {
    if (f.hostMissing) return <HostRequiredChip testid={`catalog-host-missing-${c.id}`} />;
    if (f.installedDone) {
      return (
        <InstalledUninstallButton
          busy={uninstalling === c.id}
          onUninstall={() => f.installedApp && setConfirmUninstall(f.installedApp)}
          testid={`install-${c.id}`}
        />
      );
    }
    return (
      <ActionButton tone="green" icon={Download} disabled={f.busy} onClick={() => installCatalogApp(c.id)} testid={`install-${c.id}`}>
        {f.busy ? 'Installing…' : f.updatable ? 'Update' : f.installed ? 'Replace' : 'Install'}
      </ActionButton>
    );
  }

  function CatalogView() {
    if (catalogApps === null) {
      return <div className="text-base py-8 text-center" style={{ color: 'var(--fg-tertiary)' }}>Loading catalog…</div>;
    }
    if (catalogApps.length === 0) {
      return (
        <div className="text-base py-8 text-center rounded-[var(--radius-md)]" style={{ color: 'var(--fg-tertiary)', border: '1px dashed var(--border-secondary)' }}>
          No catalog apps available — check the cloud connection.
        </div>
      );
    }
    // Uninstallable (host-required, host offline) apps sink to the bottom.
    const sorted = localOnline ? catalogApps : [...catalogApps].sort(
      (a, b) => Number(!!a.requiresHost) - Number(!!b.requiresHost),
    );
    // 2-up on a laptop, 3-up on a wide screen: cards flow at ≥360px each and
    // the container's 1360px cap stops the grid at three columns.
    return (
      <div className="grid gap-x-6 gap-y-8" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
        {sorted.map((c) => {
          const f = catalogFlags(c);
          const open = () => openCatalogApp(c.id);
          const site = c.website ?? siteWord(c.matches);
          return (
            <div key={c.id} data-testid={`catalog-card-${c.id}`} style={f.hostMissing ? { opacity: 0.6 } : undefined}>
              <MediaThumb media={c.media} name={c.name} onClick={open} testid={`catalog-thumb-${c.id}`} />
              <div className="mt-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); open(); }}
                    className="block text-lg font-semibold leading-snug truncate no-underline cursor-pointer"
                    style={{ color: 'var(--fg-primary)' }}
                  >
                    {c.name}
                  </a>
                  <div className="text-[15px] line-clamp-2" style={{ color: 'var(--fg-secondary)' }}>{c.description}</div>
                  {site && (
                    <div className="flex items-center gap-1.5 text-sm mt-0.5" style={{ color: 'var(--fg-tertiary)' }} data-testid={`catalog-sites-${c.id}`}>
                      <Globe size={14} />
                      {site}
                    </div>
                  )}
                </div>
                <div className="shrink-0">
                  <CatalogAction c={c} f={f} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Catalog detail page (card click): AppView-like header — full description,
  // lifecycle actions, the preview video top-right — over the app's real UI,
  // dimmed and click-disabled, when the cloud can serve it (manifest present).
  function CatalogDetail({ appId }: { appId: string }) {
    const c = (catalogApps || []).find((x) => x.id === appId);
    if (!c) return null;
    const f = catalogFlags(c);
    const sites = c.matches?.length ? appSites({ userscripts: [{ matches: c.matches }] }) : null;
    const appDisabled = disabledApps.has(c.id);
    return (
      <div className="-m-8 flex flex-col" style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
        <header className="shrink-0 px-8 pt-6 pb-6 border-b" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-tertiary)' }} data-testid="catalog-detail-header">
          <nav className="inline-flex items-center gap-1.5 mb-5 text-base" style={{ color: 'var(--fg-tertiary)' }} data-testid="catalog-detail-breadcrumb">
            <button type="button" onClick={() => openCatalogApp(null)} className="bg-transparent border-0 p-0 text-[22px] font-medium cursor-pointer" style={{ color: 'var(--fg-tertiary)' }}>Catalog</button>
            <ChevronRight size={17} style={{ opacity: 0.6 }} />
            <span className="text-[22px] font-medium truncate" style={{ color: 'var(--fg-secondary)' }}>{c.name}</span>
          </nav>
          <div className="flex items-start gap-8">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-2xl font-semibold tracking-tight" style={{ color: 'var(--fg-primary)' }} data-testid="catalog-detail-title">{c.name}</h1>
                <Badge color={PILL.catalog}>v{c.version}</Badge>
                {f.installedDone && <Badge color={PILL.green}>Installed</Badge>}
                {f.installed && !f.fromCatalog && <Badge color={PILL.neutral}>Installed locally</Badge>}
                {f.updatable && <Badge color={PILL.update}>Update available</Badge>}
              </div>
              <p className="mt-1.5 text-[15px] leading-relaxed max-w-2xl" style={{ color: 'var(--fg-secondary)' }}>{c.description}</p>
              {sites && <SiteList sites={sites} testid="catalog-detail-sites" />}
              {f.installed && !f.fromCatalog && (
                <div className="text-sm mt-2" style={{ color: 'var(--fg-tertiary)' }}>
                  A local app with this id exists — installing replaces it with the catalog version.
                </div>
              )}
              <div className="flex items-center gap-2 mt-4">
                {f.installedDone ? (<>
                  <ActionButton tone="green" onClick={() => openApp(c.id)} testid="catalog-detail-open">Open app</ActionButton>
                  <ToggleSwitch on={!appDisabled} onToggle={() => toggleApp(c.id)} title={appDisabled ? 'Enable' : 'Disable'} />
                  <ActionButton tone="danger" variant="outline" icon={Trash2} disabled={uninstalling === c.id} onClick={() => f.installedApp && setConfirmUninstall(f.installedApp)}>
                    {uninstalling === c.id ? 'Removing…' : 'Uninstall'}
                  </ActionButton>
                </>) : (
                  <CatalogAction c={c} f={f} />
                )}
                {f.cloudInstalled && localOnline && (
                  <Tooltip content={<span>Copies the source into ~/.airglow/apps — your local copy then serves the app.</span>}>
                    <ActionButton
                      tone="neutral"
                      variant="outline"
                      icon={Download}
                      disabled={f.busy}
                      onClick={() => installCatalogApp(c.id, { daemon: true })}
                      testid={`edit-locally-${c.id}`}
                    >
                      Edit locally
                    </ActionButton>
                  </Tooltip>
                )}
              </div>
            </div>
            {(c.media?.video || c.media?.thumbnail) && (
              <div className="shrink-0 overflow-hidden border" style={{ width: 'clamp(400px, 42vw, 720px)', aspectRatio: '16 / 10', borderRadius: 'var(--radius-md)', borderColor: 'var(--border-tertiary)', boxShadow: 'var(--shadow-card)' }}>
                {c.media?.video
                  ? <DetailVideo src={c.media.video} poster={c.media.thumbnail} />
                  : <img src={c.media.thumbnail} alt="" className="w-full h-full object-cover" />}
              </div>
            )}
          </div>
        </header>
        {c.manifest && cloudApiUrl && (
          <div className="relative flex-1 flex flex-col" style={{ minHeight: 520 }} data-testid="catalog-detail-preview">
            {/* autoHeight grows the iframe to its content, so the whole app is
                visible and the page scroll covers it — the frame itself stays
                click-disabled. */}
            <div className="flex-1 flex flex-col" style={{ pointerEvents: 'none', opacity: 0.5, filter: 'saturate(0.9)' }}>
              <AppFrame appId={c.id} origin={cloudApiUrl} autoHeight />
            </div>
            <div
              className="absolute left-1/2 -translate-x-1/2 top-4 px-3 py-1 rounded-full text-sm font-medium border"
              style={{ background: 'var(--bg-white)', color: 'var(--fg-tertiary)', borderColor: 'var(--border-secondary)', boxShadow: 'var(--shadow-card)' }}
            >
              Preview{f.installedDone ? '' : ' — install to interact'}
            </div>
          </div>
        )}
      </div>
    );
  }

  const local = apps || [];

  // The single-shell app view: native header (breadcrumb, title, badges, sites,
  // Enable/Disable, Uninstall, Secrets) over the app's own UI in a sandboxed
  // iframe. The header reuses the same lifecycle handlers as the list cards.
  function AppView({ appId }: { appId: string }) {
    const app = local.find((a) => a.id === appId);
    const disabled = disabledApps.has(appId);
    const prov = provenance[appId];
    const hasSecrets = (envApps.find((a) => a.appId === appId)?.keys.length ?? 0) > 0;
    const sites = appSites(app);
    const name = app?.name ?? appId;
    return (
      <div className="-m-8 flex flex-col" style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
        <header className="shrink-0 px-8 pt-6 pb-6 border-b" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-tertiary)' }} data-testid="app-view-header">
          <nav className="inline-flex items-center gap-1.5 mb-5 text-base" style={{ color: 'var(--fg-tertiary)' }} data-testid="app-breadcrumb">
            <button type="button" onClick={() => openApp(null)} className="bg-transparent border-0 p-0 text-[22px] font-medium cursor-pointer" style={{ color: 'var(--fg-tertiary)' }}>Apps</button>
          </nav>
          <div className="flex items-center gap-2.5 flex-wrap">
            <ToggleSwitch on={!disabled} onToggle={() => toggleApp(appId)} title={disabled ? 'Enable' : 'Disable'} testid="app-toggle" />
            <h1 className="text-2xl font-semibold tracking-tight" style={{ color: 'var(--fg-primary)' }} data-testid="app-page-title">{name}</h1>
            {disabled && <Badge color={PILL.error} solid>Disabled</Badge>}
            {prov || app?._sourceType === 'cloud'
              ? <Badge color={PILL.catalog}>Catalog{app?.version ? ` · v${app.version}` : ''}</Badge>
              : <Badge color={PILL.local}>Local</Badge>}
            {prov?.modified && <Badge color={PILL.green}>Modified</Badge>}
          </div>
          {app?.description && <p className="mt-1.5 text-[15px] leading-relaxed max-w-2xl" style={{ color: 'var(--fg-secondary)' }}>{app.description}</p>}
          {sites && <SiteList sites={sites} testid="app-sites" />}
          <div className="flex items-center gap-2 mt-4">
            <ActionButton tone="danger" variant="outline" icon={Trash2} onClick={() => app && setConfirmUninstall(app)} testid="app-uninstall">
              Uninstall
            </ActionButton>
            {hasSecrets && (
              <ActionButton tone="neutral" variant="outline" icon={KeyRound} onClick={() => openSecrets(appId)} testid="app-secrets">
                Secrets
              </ActionButton>
            )}
          </div>
        </header>
        {(app?._source?.url ?? daemonOriginUrl)
          ? <AppFrame appId={appId} origin={app?._source?.url ?? daemonOriginUrl!} page={appPage} autoHeight />
          : <div className="flex-1 p-8 text-base" style={{ color: 'var(--fg-tertiary)' }}>Loading…</div>}
      </div>
    );
  }

  // Focused popup (openApp({ window: true })): just the app frame, full-viewport,
  // no sidebar/header. The frame still bridges the app's SDK to the background,
  // so app_ui calls (storage, llm, captureTab) work as they do in-dashboard.
  if (chromeless && openAppId) {
    const frameOrigin = local.find((a) => a.id === openAppId)?._source?.url ?? daemonOriginUrl;
    return (
      <div style={{ width: '100vw', height: '100vh', background: 'var(--bg-primary)' }}>
        {frameOrigin
          ? <AppFrame appId={openAppId} origin={frameOrigin} page={appPage} />
          : <div className="p-8 text-base" style={{ color: 'var(--fg-tertiary)' }}>Loading…</div>}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Sidebar — canonical nav, mirrored on every app page */}
      <aside
        className="fixed top-0 left-0 h-screen w-[240px] flex flex-col z-30 border-r"
        style={{ background: 'var(--gray-150)', borderColor: 'var(--border-secondary)', boxShadow: '2px 0 8px rgba(0,0,0,0.04)' }}
      >
        {/* Brand lockup */}
        <a
          href={chrome.runtime.getURL('dashboard.html')}
          onClick={(e) => { e.preventDefault(); openApp(null); setPage('apps'); setTab('installed'); }}
          className="px-5 pt-5 pb-4 flex items-center gap-2.5 no-underline cursor-pointer"
          data-testid="dashboard-logo"
        >
          <img src={logoUrl} alt="Airglow" width={34} height={34} />
          <span className="text-2xl" style={{ fontFamily: "'Sora', var(--font-sans, sans-serif)", fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--fg-primary)' }}>Airglow</span>
        </a>

        {/* Primary nav */}
        <nav className="flex-1 overflow-y-scroll flex flex-col gap-0.5 px-3 pt-1 sidebar-scroll">
          <NavRow
            icon={LayoutGrid}
            label="Apps"
            active={page === 'apps' && !openAppId && activeTab === 'installed'}
            onClick={() => { openApp(null); setPage('apps'); setTab('installed'); }}
            testId="nav-apps"
          />
          <div className="flex flex-col">
            {error && <div className="pl-[38px] pr-3 py-1.5 text-sm" style={{ color: 'var(--fg-tertiary)' }}>Apps server offline</div>}
            {!error && apps === null && <div className="pl-[38px] pr-3 py-1.5 text-sm" style={{ color: 'var(--fg-tertiary)' }}>Loading…</div>}
            {!error && apps !== null && local.length === 0 && <div className="pl-[38px] pr-3 py-1.5 text-sm" style={{ color: 'var(--fg-tertiary)' }}>No apps installed</div>}
            {sortByOrder(local, 'local').map((app) => (
              <AppRow
                key={app.id}
                name={app.name}
                active={openAppId === app.id}
                onClick={() => openApp(app.id)}
                testId={`sidebar-local-${app.id}`}
              />
            ))}
          </div>
          <NavRow
            icon={Store}
            label="Catalog"
            active={page === 'apps' && !openAppId && activeTab === 'catalog'}
            onClick={() => { openApp(null); setPage('apps'); setTab('catalog'); void loadCatalog(); }}
            badge={catalogApps ? <span className="text-sm font-normal" style={{ color: 'var(--fg-tertiary)' }}>{catalogApps.length}</span> : null}
            testId="nav-catalog"
          />
        </nav>

        {/* Footer card: server status, Settings, cloud + version */}
        <div className="px-3 pb-2 pt-2">
          {/* Reopens the "Develop apps" guide popup (auto-shown once on first
              run). Sidebar bg is --gray-150, so hover steps to --gray-200. */}
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            className="w-full h-10 px-3 mb-2 rounded-lg text-base font-medium cursor-pointer transition-colors border flex items-center gap-2"
            style={{
              color: devIssue === 'offline' ? 'var(--error)' : 'var(--fg-secondary)',
              borderColor: devIssue === 'offline' ? 'color-mix(in srgb, var(--error) 40%, var(--border-secondary))' : 'var(--border-secondary)',
              background: 'var(--bg-white)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gray-200)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; }}
            data-testid="develop-apps-button"
          >
            <Code size={16} />
            {devIssue === 'offline' ? 'Start Daemon' : 'Develop apps'}
            {devIssue && (
              <TriangleAlert
                size={15}
                className="ml-auto shrink-0"
                style={{ color: 'var(--error)' }}
                data-testid="develop-apps-warning"
              />
            )}
          </button>
          <div className="rounded-lg p-2" style={{ background: 'var(--bg-white)', border: '1px solid var(--border-tertiary)' }}>
            <div className="px-2 pt-1 pb-2.5 flex flex-col gap-1" data-testid="local-apps-status">
              {/* Two independent channels: the native-messaging connector (agent
                  browser control) and the daemon HTTP server (apps, catalog
                  installs). In the normal agreeing states one line stands for
                  both; when they disagree (e.g. a source daemon running without
                  the connector) show both. */}
              {!(nativeHostConnected && localOnline) && (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--fg-tertiary)' }} data-testid="native-host-status">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: nativeHostConnected === null ? 'var(--fg-tertiary)' : nativeHostConnected ? 'var(--olive)' : 'var(--error)' }} />
                  <span><span style={{ color: 'var(--olive)', fontWeight: 600 }}>Native host</span> {nativeHostConnected === null ? '…' : nativeHostConnected ? 'online' : 'offline'}</span>
                </div>
              )}
              {!(nativeHostConnected === false && localOnline === false) && (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--fg-tertiary)' }} data-testid="daemon-status">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: localOnline === null ? 'var(--fg-tertiary)' : localOnline ? 'var(--olive)' : 'var(--error)' }} />
                  <span><span style={{ color: 'var(--olive)', fontWeight: 600 }}>Daemon</span> {localOnline === null ? '…' : localOnline ? 'online' : 'offline'}</span>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="w-full h-10 px-3 rounded-lg text-base font-medium cursor-pointer transition-colors border flex items-center gap-2"
                style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
                data-testid="settings-button"
              >
                <Settings size={16} />
                Settings
              </button>
              <button
                type="button"
                disabled={!authSession}
                title={!authSession ? 'Sign in to view logs' : undefined}
                onClick={() => { if (authSession) { openApp(null); setPage('logs'); } }}
                className="w-full h-10 px-3 rounded-lg text-base font-medium transition-colors border flex items-center gap-2"
                style={{
                  color: page === 'logs' ? 'var(--fg-primary)' : 'var(--fg-secondary)',
                  borderColor: 'var(--border-secondary)',
                  background: page === 'logs' ? 'var(--bg-tertiary)' : 'var(--bg-primary)',
                  cursor: authSession ? 'pointer' : 'not-allowed',
                  opacity: authSession ? 1 : 0.5,
                }}
                onMouseEnter={(e) => { if (authSession) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = page === 'logs' ? 'var(--bg-tertiary)' : 'var(--bg-primary)'; }}
                data-testid="nav-logs"
              >
                <ScrollText size={16} />
                Logs
                {unseenErrorCount > 0 && page !== 'logs' && (
                  <span className="ml-auto inline-flex items-center gap-1 text-sm font-semibold tabular-nums" style={{ color: 'var(--error)' }} data-testid="logs-unseen-badge">
                    <AlertTriangle size={16} />{unseenErrorCount > 99 ? '99+' : unseenErrorCount}
                  </span>
                )}
              </button>
              {/* Dev-only shortcut to the component mock gallery (planmock.html). */}
              {import.meta.env.DEV && (
                <button
                  type="button"
                  onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('planmock.html') })}
                  className="w-full h-10 px-3 rounded-lg text-base font-medium cursor-pointer transition-colors border flex items-center gap-2"
                  style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
                  title="Open the component mock gallery (dev only)"
                  data-testid="mocks-button"
                >
                  <LayoutGrid size={16} />
                  Mocks
                </button>
              )}
            </div>
            {/* Cloud API row — shown only when overridden away from the default
                (api.airglow.dev); on the default there's nothing worth surfacing. */}
            {gatewayUrlInput.trim() && (
              <div
                className="px-2 pt-1.5 mt-1 break-all border-t"
                style={{ color: 'var(--error)', borderColor: 'var(--border-tertiary)', fontSize: '12px' }}
                title={(cloudOnline === false ? 'Unreachable — the cloud did not respond.\n' : '') + `Override — default is ${getDefaultCloudApiUrl()}`}
                data-testid="sidebar-cloud-api-url"
              >
                <span className="inline-flex items-center gap-1.5 align-middle">
                  <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cloudOnline === null ? 'var(--fg-tertiary)' : cloudOnline ? 'var(--olive)' : 'var(--error)' }} data-testid="sidebar-cloud-api-status-dot" />
                  Cloud API:
                </span>{' '}
                {gatewayUrlInput.trim()} (override)
                {cloudOnline === false && <span style={{ color: 'var(--error)' }}> — unreachable</span>}
              </div>
            )}
            <div className="px-2 pt-1" style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>
              <div>v{chrome.runtime.getManifest().version}{hostVersion ? ` (host v${hostVersion})` : ''}</div>
              <div className="flex items-center gap-2 pt-1">
              {extUpdate && (
                <button
                  type="button"
                  onClick={applyExtUpdate}
                  className="h-5 px-2 rounded-sm cursor-pointer border-0 font-medium"
                  style={{ background: 'var(--olive)', color: 'var(--bg-white)', fontSize: '11px' }}
                  title={`Update to v${extUpdate}`}
                  data-testid="sidebar-ext-update-button"
                >
                  Update to v{extUpdate}
                </button>
              )}
              <button
                type="button"
                onClick={() => chrome.tabs.create({ url: 'https://github.com/airglow-inc/airglow-sdk' })}
                className="ml-auto cursor-pointer border-0 bg-transparent p-0 inline-flex items-center gap-1.5 transition-colors"
                style={{ color: 'var(--fg-tertiary)', fontSize: '14px', fontFamily: 'var(--font-sans)' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg-secondary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-tertiary)'; }}
                title="Airglow SDK on GitHub"
                data-testid="sidebar-github-button"
              >
                <GithubLogo size={15} />
                Github
              </button>
              </div>
            </div>
          </div>
          {hostUpdate?.updateAvailable && hostUpdate.mode === 'binary' && (
            <button
              type="button"
              onClick={updateHost}
              disabled={hostUpdating}
              className="flex items-center gap-2 w-fit mx-auto mt-2 h-10 px-4 rounded-lg text-base font-semibold cursor-pointer border"
              style={{ background: 'var(--olive)', color: 'var(--bg-white)', borderColor: 'rgba(0, 0, 0, 0.3)', boxShadow: 'var(--shadow-card)', opacity: hostUpdating ? 0.6 : 1 }}
              title={hostUpdateError ?? `Update host to v${hostUpdate.latest}`}
              data-testid="sidebar-host-update-button"
            >
              {hostUpdating
                ? <LoaderCircle size={17} className="shrink-0 animate-spin" />
                : <Download size={17} className="shrink-0" />}
              {hostUpdating ? 'Updating…' : 'Update Airglow'}
            </button>
          )}
          {hostUpdateError && !hostUpdating && (
            <div
              className="w-fit max-w-[210px] mx-auto mt-1.5 text-center"
              style={{ color: 'var(--error)', fontSize: '12.5px', lineHeight: '1.45' }}
              data-testid="sidebar-host-update-error"
            >
              Update failed: {hostUpdateError}
            </div>
          )}
          {hostUpdated && !hostUpdate?.updateAvailable && (
            <div
              className="flex items-center gap-2 w-fit mx-auto mt-2 h-10 px-4 rounded-lg text-base font-semibold"
              style={{ color: 'var(--olive)' }}
              data-testid="sidebar-host-updated"
            >
              <Check size={17} className="shrink-0" />
              Updated host to v{hostUpdated}
            </div>
          )}
        </div>

        {/* Tagline */}
        <div className="px-5 py-3 text-center">
          <p style={{ color: 'var(--fg-tertiary)', fontSize: '12px', letterSpacing: '0.02em', fontFamily: 'var(--font-sans)', lineHeight: '1.6' }}>
            Airglow — for those who create
          </p>
        </div>
      </aside>

      {/* Main content */}
      <main className="ml-[240px] flex-1 p-8 min-w-0 overflow-x-hidden">
        {/* Server-driven announcement (Edge Config → /api/announcement →
            background poll → storage cache). Renders nothing when inactive.
            Width matches the app-card column (max-w-3xl) so it doesn't span
            the full main area on wide screens. */}
        <div className="max-w-3xl">
          <AnnouncementBanner override={debugAnnouncement ? DEBUG_ANNOUNCEMENT : undefined} />
        </div>
        {!identityLoaded ? (
          <div className="p-5 rounded-[var(--radius-md)] border text-base" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-tertiary)', color: 'var(--fg-secondary)', boxShadow: 'var(--shadow-card)' }}>
            Loading Airglow setup…
          </div>
        ) : !authSession ? (
          /* Sign-in gate. Everyone signs in, including pre-auth installs (one
             click; Chrome pre-selects the profile account; userId stays
             gaia_<sub> so history carries over). Local builds go through the
             launchWebAuthFlow popup; the local backend needs
             AIRGLOW_GOOGLE_CLIENT_IDS + AIRGLOW_AUTH_SECRET set. */
          <div className="min-h-[calc(100vh-64px)] flex items-center justify-center">
            <div
              className="w-full max-w-[520px] p-6 rounded-[var(--radius-md)] border"
              style={{
                background: 'var(--bg-white)',
                borderColor: 'var(--border-tertiary)',
                boxShadow: 'var(--shadow-card)',
              }}
              data-testid="banner-signin-onboarding"
            >
              <div className="text-lg font-semibold mb-4" style={{ color: 'var(--fg-primary)' }}>
                Sign in to Airglow
              </div>
              <div className="flex flex-col gap-3">
                <button
                  onClick={startGoogleSignIn}
                  disabled={signingIn}
                  className="h-11 px-5 rounded-md text-base font-medium cursor-pointer transition-all border flex items-center justify-center gap-2.5"
                  style={{ color: 'var(--fg-primary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-white)', opacity: signingIn ? 0.6 : 1 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; }}
                  data-testid="google-signin-button"
                >
                  <GoogleLogo />
                  {signingIn ? 'Signing in…' : 'Sign in with Google'}
                </button>
                {signInError && (
                  <div className="text-sm" style={{ color: 'var(--error)' }} data-testid="google-signin-error">{signInError}</div>
                )}
              </div>
            </div>
          </div>
        ) : page === 'logs' ? (
          <LogsPage />
        ) : openAppId ? (
          // Invoke AppView as a function rather than <AppView/>. AppView is
          // defined inside App, so as a JSX element its type changes every
          // render — React would unmount/remount the whole subtree (incl. the
          // app's <iframe>) on each App re-render, reloading the app UI (the
          // "double refresh" when async data from loadAll lands). Called as a
          // function its tree reconciles in place and the iframe is preserved.
          AppView({ appId: openAppId })
        ) : activeTab === 'catalog' && catalogOpenId ? (
          // Same function-call rule as AppView: keeps the preview iframe and
          // the header video from remounting on every App re-render.
          CatalogDetail({ appId: catalogOpenId })
        ) : (
        <div className="-m-8 flex flex-col" style={{ minHeight: '100vh' }}>
          <header className="shrink-0 px-8 pt-6 pb-6 border-b" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-tertiary)' }}>
            <div className="flex items-center gap-1.5 text-base" data-testid="dashboard-breadcrumb">
              <span className="text-[22px] font-medium" style={{ color: 'var(--fg-tertiary)' }}>{activeTab === 'catalog' ? 'Catalog' : 'Apps'}</span>
              {activeTab === 'catalog' && (
                <button
                  type="button"
                  onClick={() => chrome.tabs.create({ url: 'https://github.com/airglow-inc/airglow-catalog' })}
                  className="ml-3 h-9 px-3 rounded-lg text-base font-medium cursor-pointer transition-colors border inline-flex items-center gap-1.5"
                  style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-white)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; }}
                  title="Catalog source on GitHub"
                  data-testid="catalog-github-button"
                >
                  <GithubLogo size={16} />
                  Source
                </button>
              )}
            </div>
          </header>
          {/* Bottom padding leaves scroll headroom past the last row, so the
              floating Feedback button never permanently covers a card's
              actions. */}
          <div className="p-8" style={{ paddingBottom: 112 }}>
        <div
          className={dashSetup === 'pin' ? 'flex items-center justify-center' : activeTab === 'catalog' ? 'max-w-[1360px]' : 'max-w-3xl'}
          style={dashSetup === 'pin' ? { minHeight: 'calc(100vh - 180px)' } : undefined}
        >
          {/* Chrome-setup nag (pin to toolbar). While it's up, it renders as a
              fixed-width card centered in the content area and the apps/catalog
              list is hidden until the user pins or dismisses it. Sign-in and host
              install are handled by the full-page gates above; User Scripts by
              the blocking UserScriptsOverlay (rendered at the root below). */}
          <SetupBanners variant="dashboard" steps={['pin']} onActiveChange={setDashSetup} />
          {dashSetup !== 'pin' && (activeTab === 'installed' ? (
            <>
              {apps === null && (
                <div className="text-base py-8 text-center" style={{ color: 'var(--fg-tertiary)' }}>Loading...</div>
              )}
              {local.length === 0 && apps !== null ? (
                <div className="text-base py-8 text-center rounded-[var(--radius-md)]" style={{ color: 'var(--fg-tertiary)', border: '1px dashed var(--border-secondary)' }}>
                  No apps installed — browse the{' '}
                  <button onClick={() => { setTab('catalog'); void loadCatalog(); }} className="underline cursor-pointer" style={{ color: 'var(--clay)' }}>Catalog</button>{' '}to add one.
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {/* Function call, not JSX — same remount-avoidance rule as
                      AppView/CatalogView, so the toggle's CSS transition (and
                      any card DOM state) survives App re-renders. */}
                  {sortByOrder(local, 'local').map((app, i) => (
                    <Fragment key={app.id}>{AppCard({ app, section: 'local', index: i, list: local })}</Fragment>
                  ))}
                </div>
              )}
            </>
          ) : (
            // Function call, not JSX — same remount-avoidance rule as AppView
            // (hover-playing card videos would reset on every App re-render).
            CatalogView()
          ))}
        </div>
          </div>
        </div>
        )}
      </main>

      <button
        onClick={() => setFeedbackOpen(true)}
        className="fixed right-5 z-40 h-12 px-4 rounded-full text-base font-medium cursor-pointer transition-all border inline-flex items-center gap-2"
        style={{
          // Pinned to the viewport corner; z-40 floats it over the offline
          // banner (z-30) rather than stacking above it.
          bottom: 20,
          color: 'var(--bg-white)',
          borderColor: 'color-mix(in srgb, var(--clay) 80%, transparent)',
          background: 'var(--clay)',
          boxShadow: '0 14px 34px rgba(28,25,23,0.22)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'translateY(-1px)';
          e.currentTarget.style.boxShadow = '0 18px 42px rgba(28,25,23,0.26)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = '0 14px 34px rgba(28,25,23,0.22)';
        }}
        data-testid="feedback-button"
        aria-label="Open feedback"
        title="Feedback"
      >
        <MessageSquare size={17} />
        Feedback
      </button>

      {/* "Develop apps" guide popup. Auto-opens once when the local server
          first comes up on the Apps page; the sidebar button reopens it. */}
      {guideOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          style={{ background: 'rgba(28,25,23,0.4)' }}
          onClick={(e) => { if (e.target === e.currentTarget) closeGuide(); }}
          data-testid="dev-guide-backdrop"
        >
          <div
            className="relative w-full max-w-[620px] rounded-lg p-7 border"
            style={{
              background: 'var(--bg-white)',
              borderColor: 'var(--border-tertiary)',
              boxShadow: '0 20px 60px rgba(28,25,23,0.2)',
              color: 'var(--fg-primary)',
            }}
            data-testid="dev-guide-popup"
          >
            <button
              type="button"
              onClick={closeGuide}
              className="absolute top-3 right-3 h-9 w-9 inline-flex items-center justify-center rounded-md cursor-pointer border-0 bg-transparent transition-colors"
              style={{ color: 'var(--fg-secondary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              aria-label="Close"
              title="Close"
              data-testid="dev-guide-close"
            >
              <X size={18} />
            </button>
            <div className="text-[21px] font-semibold flex items-center gap-2 pr-8" style={{ color: 'var(--fg-primary)' }}>
              <Code size={24} style={{ color: 'var(--clay)' }} />
              Develop your own apps
            </div>
            {/* Offline moves this line below the install command; Windows
                drops it (no workspace will ever be created there). */}
            {devIssue === null && (
              <div className="mt-2 text-[16px]" style={{ color: 'var(--fg-secondary)' }}>
                Your workspace is at <code style={{ fontFamily: 'var(--font-mono)', fontSize: '14.5px' }}>~/.airglow</code>. It contains <code style={{ fontFamily: 'var(--font-mono)', fontSize: '14.5px' }}>AGENTS.md</code> — agent instructions on how to use Airglow.
              </div>
            )}
            {/* Problem callout — mirrors the warning icon on the sidebar's
                "Develop apps" button. When present it replaces the steps:
                Windows has no host at all; offline shows only the install
                command (the fix) until the server is up. */}
            {devIssue === 'windows' && (
              <div
                className="mt-4 p-4 rounded-lg border"
                style={{
                  background: 'color-mix(in srgb, var(--error) 7%, var(--bg-white))',
                  borderColor: 'color-mix(in srgb, var(--error) 30%, var(--border-tertiary))',
                }}
                data-testid="dev-guide-windows-unsupported"
              >
                <div className="inline-flex items-center gap-2 text-[18px] font-semibold" style={{ color: 'var(--fg-primary)' }}>
                  <TriangleAlert size={19} className="shrink-0" style={{ color: 'var(--error)' }} />
                  Developing apps on Windows is not supported
                </div>
                <div className="mt-1 text-[16px]" style={{ color: 'var(--fg-secondary)' }}>
                  Airglow apps can only be developed on Mac or Linux.
                </div>
              </div>
            )}
            {devIssue === 'offline' && (
              <div className="mt-4" data-testid="dev-guide-offline">
                <div
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[18px] font-semibold"
                  style={{
                    color: 'var(--fg-primary)',
                    background: 'color-mix(in srgb, var(--error) 7%, var(--bg-white))',
                    border: '1px solid color-mix(in srgb, var(--error) 30%, var(--border-tertiary))',
                  }}
                >
                  <TriangleAlert size={19} className="shrink-0" style={{ color: 'var(--error)' }} />
                  Local daemon is offline
                </div>
                <div className="mt-3.5 text-[16px]" style={{ color: 'var(--fg-secondary)' }}>
                  Run this command in a terminal to install Airglow workspace:
                </div>
                <div className="mt-2.5 flex items-stretch gap-2">
                  <button
                    type="button"
                    onClick={() => copyGuide(HOST_INSTALL_CMD, 'install')}
                    title={guideCopied === 'install' ? 'Copied' : 'Copy'}
                    className="shrink-0 flex items-center justify-center w-9 rounded-sm cursor-pointer"
                    style={{ background: 'var(--gray-150)', border: '1px solid var(--border-tertiary)', color: 'var(--fg-secondary)' }}
                  >
                    {guideCopied === 'install' ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                  <pre className="flex-1 min-w-0 p-2.5 rounded-sm text-[15px] overflow-x-auto" style={{ background: 'var(--gray-150)', border: '1px solid var(--border-tertiary)', fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>
                    {HOST_INSTALL_CMD}
                  </pre>
                </div>
                <div className="mt-3.5 text-[16px]" style={{ color: 'var(--fg-secondary)' }}>
                  It creates your <code style={{ fontFamily: 'var(--font-mono)', fontSize: '14.5px' }}>~/.airglow</code> workspace containing <code style={{ fontFamily: 'var(--font-mono)', fontSize: '14.5px' }}>AGENTS.md</code> — agent instructions on how to use Airglow.
                </div>
              </div>
            )}
            {devIssue === null && (
            <div className="mt-4 flex flex-col gap-4 text-[17px]" style={{ color: 'var(--fg-secondary)' }}>
              <div>
                <div className="flex items-center gap-2.5" style={{ color: 'var(--fg-primary)' }}>
                  <GuideStep n={1} />
                  <span>Start a coding agent in your Airglow workspace</span>
                </div>
                <div className="mt-2 ml-[34px] flex items-stretch gap-2">
                  <button
                    type="button"
                    onClick={() => copyGuide(DEV_GUIDE_AGENT_CMD, 'cmd')}
                    title={guideCopied === 'cmd' ? 'Copied' : 'Copy'}
                    className="shrink-0 flex items-center justify-center w-9 rounded-sm cursor-pointer"
                    style={{ background: 'var(--gray-150)', border: '1px solid var(--border-tertiary)', color: 'var(--fg-secondary)' }}
                  >
                    {guideCopied === 'cmd' ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                  <pre className="flex-1 min-w-0 p-2.5 rounded-sm text-[15px] overflow-x-auto" style={{ background: 'var(--gray-150)', border: '1px solid var(--border-tertiary)', fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>
                    {DEV_GUIDE_AGENT_CMD}
                  </pre>
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2.5" style={{ color: 'var(--fg-primary)' }}>
                  <GuideStep n={2} />
                  <span>Ask it to build what you want — for example:</span>
                </div>
                <div className="mt-2 ml-[34px] flex items-stretch gap-2">
                  <button
                    type="button"
                    onClick={() => copyGuide(DEV_GUIDE_EXAMPLE_PROMPT, 'prompt')}
                    title={guideCopied === 'prompt' ? 'Copied' : 'Copy'}
                    className="shrink-0 flex items-center justify-center w-9 rounded-sm cursor-pointer"
                    style={{ background: 'var(--gray-150)', border: '1px solid var(--border-tertiary)', color: 'var(--fg-secondary)' }}
                  >
                    {guideCopied === 'prompt' ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                  <pre className="flex-1 min-w-0 p-2.5 rounded-sm text-[15px] overflow-x-auto" style={{ background: 'var(--gray-150)', border: '1px solid var(--border-tertiary)', fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>
                    {DEV_GUIDE_EXAMPLE_PROMPT}
                  </pre>
                </div>
              </div>
              <div className="text-[16px]" style={{ color: 'var(--fg-secondary)' }}>
                Apps are saved at <code style={{ fontFamily: 'var(--font-mono)', fontSize: '14.5px' }}>~/.airglow/apps</code> and hot-reload into the extension.
              </div>
            </div>
            )}
          </div>
        </div>
      )}

      {/* Transient notice toast (auto-hides after 5s) */}
      {notice && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-md border text-sm font-medium"
          style={{
            background: 'color-mix(in srgb, var(--error) 8%, var(--bg-white))',
            borderColor: 'color-mix(in srgb, var(--error) 30%, var(--border-tertiary))',
            color: 'var(--fg-primary)',
            boxShadow: '0 8px 24px rgba(28,25,23,0.15)',
          }}
          data-testid="dashboard-notice"
        >
          {notice}
        </div>
      )}

      {/* Feedback modal */}
      {/* Uninstall confirmation modal (replaces window.confirm) */}
      {showHostPopup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          style={{ background: 'rgba(28,25,23,0.4)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowHostPopup(false); }}
          data-testid="host-popup-backdrop"
        >
          <div
            className="w-full max-w-[520px] rounded-lg p-8 border"
            style={{
              background: 'var(--bg-white)',
              borderColor: 'var(--border-tertiary)',
              boxShadow: '0 20px 60px rgba(28,25,23,0.2)',
              color: 'var(--fg-primary)',
            }}
            data-testid="host-popup"
          >
            <h3 className="text-2xl font-bold" style={{ color: 'var(--fg-primary)' }}>
              This app needs the Airglow host
            </h3>
            <p className="mt-3 text-base" style={{ color: 'var(--fg-secondary)' }}>
              Install it in a terminal, then come back:
            </p>
            <div
              className="mt-3 pl-3 pr-1.5 py-1.5 rounded-md text-sm font-mono break-all flex items-center justify-between gap-2"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--fg-primary)' }}
            >
              <span data-testid="host-install-cmd">{HOST_INSTALL_CMD}</span>
              <button
                type="button"
                className="shrink-0 h-8 w-8 inline-flex items-center justify-center rounded-md cursor-pointer border-0 bg-transparent"
                style={{ color: 'var(--fg-secondary)' }}
                title="Copy"
                onClick={() => {
                  navigator.clipboard.writeText(HOST_INSTALL_CMD).then(() => {
                    setHostCmdCopied(true);
                    setTimeout(() => setHostCmdCopied(false), 1500);
                  });
                }}
              >
                {hostCmdCopied ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </div>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setShowHostPopup(false)}
                className="h-9 px-4 rounded-md text-base font-medium cursor-pointer border"
                style={{
                  color: 'var(--fg-primary)',
                  borderColor: 'var(--border-secondary)',
                  background: 'var(--bg-white)',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmUninstall && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          style={{ background: 'rgba(28,25,23,0.4)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmUninstall(null); }}
          data-testid="uninstall-modal-backdrop"
        >
          <div
            className="w-full max-w-[520px] rounded-lg p-8 border"
            style={{
              background: 'var(--bg-white)',
              borderColor: 'var(--border-tertiary)',
              boxShadow: '0 20px 60px rgba(28,25,23,0.2)',
              color: 'var(--fg-primary)',
            }}
            data-testid="uninstall-modal"
          >
            <h3 className="text-2xl font-bold" style={{ color: 'var(--fg-primary)' }}>
              Uninstall {confirmUninstall.name}?
            </h3>
            <p className="mt-3 text-base" style={{ color: 'var(--fg-secondary)' }}>
              {confirmUninstall._sourceType === 'cloud'
                ? 'This removes the app from your account. You can reinstall it from the Catalog.'
                : "This deletes the app's folder and any saved secrets. This cannot be undone."}
            </p>
            {confirmUninstall._sourceType !== 'cloud' && (
              <div
                className="mt-3 px-3 py-2 rounded-md text-sm font-mono break-all"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--fg-primary)' }}
                data-testid="uninstall-path"
              >
                apps/{confirmUninstall.id}
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmUninstall(null)}
                className="h-9 px-4 rounded-md text-base font-medium cursor-pointer border"
                style={{
                  color: 'var(--fg-primary)',
                  borderColor: 'var(--border-secondary)',
                  background: 'var(--bg-white)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; }}
                data-testid="uninstall-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => performUninstall(confirmUninstall)}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-base font-medium cursor-pointer border"
                style={{ color: 'var(--bg-white)', borderColor: 'var(--error)', background: 'var(--error)' }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                data-testid="uninstall-confirm"
                autoFocus
              >
                <Trash2 size={15} />
                Uninstall
              </button>
            </div>
          </div>
        </div>
      )}

      <FeedbackModal
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        source={{ appId: 'dashboard', appName: 'Airglow Dashboard', sourceType: 'extension-dashboard' }}
      />

      {/* Settings modal */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.4)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}
          data-testid="settings-modal-backdrop"
        >
          <div
            className="w-[420px] max-h-[85vh] overflow-y-auto rounded-lg p-6"
            style={{ background: 'var(--bg-white)', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}
            data-testid="settings-modal"
          >
            <div className="mb-5 flex items-start justify-between gap-3">
              <h3 className="text-2xl font-bold" style={{ color: 'var(--fg-primary)' }}>Settings</h3>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="h-8 w-8 rounded-md cursor-pointer inline-flex items-center justify-center"
                style={{ color: 'var(--fg-tertiary)', background: 'transparent', border: 0 }}
                aria-label="Close settings"
              >
                <X size={18} />
              </button>
            </div>
            <div className="py-2 flex items-center justify-between gap-4" data-testid="settings-account-row">
              <div>
                <div className="text-lg font-medium" style={{ color: 'var(--fg-primary)' }}>Account</div>
                <div className="text-sm mt-0.5" style={{ color: 'var(--fg-tertiary)' }}>
                  {authSession
                    ? (authSession.email || authSession.userId)
                    : 'Not signed in — sign in with Google to sync your identity with airglow.dev.'}
                </div>
                {signInError && !authSession && (
                  <div className="text-sm mt-0.5" style={{ color: 'var(--error)' }}>{signInError}</div>
                )}
              </div>
              <button
                type="button"
                onClick={authSession ? handleSignOut : startGoogleSignIn}
                disabled={signingIn}
                className="shrink-0 h-9 px-4 text-base font-medium rounded-sm cursor-pointer border flex items-center gap-2"
                style={{
                  background: 'var(--bg-white)',
                  color: 'var(--fg-primary)',
                  borderColor: 'var(--border-secondary)',
                  opacity: signingIn ? 0.6 : 1,
                }}
                data-testid="settings-account-button"
              >
                {authSession ? 'Sign out' : (<><GoogleLogo size={14} />{signingIn ? 'Signing in…' : 'Sign in'}</>)}
              </button>
            </div>
            <label
              className="flex items-center justify-between gap-4 py-2 cursor-pointer"
              data-testid="settings-side-button-row"
            >
              <div>
                <div className="text-lg font-medium" style={{ color: 'var(--fg-primary)' }}>Side button</div>
                <div className="text-sm mt-0.5" style={{ color: 'var(--fg-tertiary)' }}>
                  Show the edge button on the right side of every web page.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={sideButtonEnabled}
                onClick={() => setSideButton(!sideButtonEnabled)}
                className="relative shrink-0 transition-colors cursor-pointer rounded-full border"
                style={{
                  // box-sizing: border-box from Tailwind preflight means content
                  // width = 44 - 2*1 = 42px. Knob is 18px; left positions of
                  // 2 (off) and 22 (on) give a symmetric 2px gap on each side.
                  boxSizing: 'border-box',
                  width: 44, height: 24,
                  background: sideButtonEnabled ? 'var(--olive)' : 'var(--bg-tertiary)',
                  borderColor: sideButtonEnabled ? 'var(--olive)' : 'var(--border-secondary)',
                }}
                data-testid="settings-side-button-toggle"
              >
                <span
                  className="absolute top-1/2 -translate-y-1/2 rounded-full transition-all"
                  style={{
                    width: 18, height: 18,
                    left: sideButtonEnabled ? 22 : 2,
                    background: 'var(--bg-white)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                />
              </button>
            </label>
            {import.meta.env.DEV && (<>
            <label
              className="flex items-center justify-between gap-4 py-2 cursor-pointer"
              data-testid="settings-sidepanel-row"
            >
              <div>
                <div className="text-lg font-medium" style={{ color: 'var(--fg-primary)' }}>Enable sidepanel</div>
                <div className="text-sm mt-0.5" style={{ color: 'var(--fg-tertiary)' }}>
                  Toolbar icon opens the agent sidepanel instead of this dashboard.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={sidepanelEnabled}
                onClick={() => setSidepanel(!sidepanelEnabled)}
                className="relative shrink-0 transition-colors cursor-pointer rounded-full border"
                style={{
                  boxSizing: 'border-box',
                  width: 44, height: 24,
                  background: sidepanelEnabled ? 'var(--olive)' : 'var(--bg-tertiary)',
                  borderColor: sidepanelEnabled ? 'var(--olive)' : 'var(--border-secondary)',
                }}
                data-testid="settings-sidepanel-toggle"
              >
                <span
                  className="absolute top-1/2 -translate-y-1/2 rounded-full transition-all"
                  style={{
                    width: 18, height: 18,
                    left: sidepanelEnabled ? 22 : 2,
                    background: 'var(--bg-white)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                />
              </button>
            </label>
            <label
              className="flex items-center justify-between gap-4 py-2 cursor-pointer"
              data-testid="settings-daemon-disabled-row"
            >
              <div>
                <div className="text-lg font-medium" style={{ color: 'var(--fg-primary)' }}>Disable daemon</div>
                <div className="text-sm mt-0.5" style={{ color: 'var(--fg-tertiary)' }}>
                  Development only. Simulates no host installed: local apps unload, only cloud catalog apps run.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={daemonDisabled}
                onClick={() => setDaemonDisabledFlag(!daemonDisabled)}
                className="relative shrink-0 transition-colors cursor-pointer rounded-full border"
                style={{
                  boxSizing: 'border-box',
                  width: 44, height: 24,
                  background: daemonDisabled ? 'var(--error)' : 'var(--bg-tertiary)',
                  borderColor: daemonDisabled ? 'var(--error)' : 'var(--border-secondary)',
                }}
                data-testid="settings-daemon-disabled-toggle"
              >
                <span
                  className="absolute top-1/2 -translate-y-1/2 rounded-full transition-all"
                  style={{
                    width: 18, height: 18,
                    left: daemonDisabled ? 22 : 2,
                    background: 'var(--bg-white)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                />
              </button>
            </label>
            </>)}
            <div className="py-2" data-testid="settings-gateway-url-row">
              <div className="text-lg font-medium flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
                Cloud API URL
                {gatewayUrlInput.trim() && (
                  <span className="text-sm font-semibold" style={{ color: 'var(--error)' }}>overriding production</span>
                )}
              </div>
              <div className="text-sm mt-0.5 mb-1.5" style={{ color: 'var(--fg-tertiary)' }}>
                Development only. Redirects everything cloud-bound — sign-in, agent gateway, feedback. Leave empty for production.
              </div>
              <input
                type="text"
                value={gatewayUrlInput}
                onChange={(e) => setGatewayUrlInput(e.target.value)}
                onBlur={saveGatewayUrl}
                onKeyDown={(e) => { if (e.key === 'Enter') saveGatewayUrl(); }}
                placeholder="https://api.airglow.dev (default)"
                spellCheck={false}
                className="w-full h-9 px-3 text-base rounded-sm border outline-none"
                style={{
                  borderColor: gatewayUrlInput.trim() ? 'var(--error)' : 'var(--border-secondary)',
                  color: 'var(--fg-primary)',
                  background: 'var(--bg-white)',
                }}
                data-testid="settings-gateway-url-input"
              />
            </div>
            <div className="py-2" data-testid="settings-host-version-row">
              <div className="text-lg font-medium" style={{ color: 'var(--fg-primary)' }}>Airglow</div>
              <div className="text-sm mt-0.5 flex flex-col gap-0.5" style={{ color: 'var(--fg-tertiary)' }}>
                <span>Extension: v{chrome.runtime.getManifest().version}</span>
                <span style={{ color: hostUpdateError ? 'var(--error)' : undefined }}>
                  Host: {hostUpdateError ? hostUpdateError
                    : !hostUpdate ? 'not connected'
                    : hostUpdate.mode === 'source' ? (import.meta.env.DEV ? `v${hostUpdate.current} — running from source` : `v${hostUpdate.current}`)
                    : hostUpdating ? `updating to v${hostUpdate.latest}…`
                    : hostUpdate.updateAvailable ? `v${hostUpdate.current} — v${hostUpdate.latest} available`
                    : `v${hostUpdate.current}`}
                </span>
              </div>
              {hostUpdate?.updateAvailable && hostUpdate.mode === 'binary' && (
                <button
                  type="button"
                  onClick={updateHost}
                  disabled={hostUpdating}
                  className="h-8 px-3 mt-2 text-[15px] font-medium rounded-sm cursor-pointer border-0"
                  style={{
                    background: 'var(--olive)',
                    color: 'var(--bg-white)',
                    opacity: hostUpdating ? 0.6 : 1,
                  }}
                  data-testid="settings-host-update-button"
                >
                  {hostUpdating ? 'Updating…' : `Update to v${hostUpdate.latest}`}
                </button>
              )}
            </div>
            {connAccounts !== null && (
              <div className="py-2" data-testid="settings-connected-accounts-row">
                <div className="text-lg font-medium" style={{ color: 'var(--fg-primary)' }}>Connected accounts</div>
                <div className="text-sm mt-0.5 mb-1.5" style={{ color: connError ? 'var(--error)' : 'var(--fg-tertiary)' }}>
                  {connError ?? 'Third-party services apps have connected. Each connection belongs to one app.'}
                </div>
                {connAccounts.length === 0 ? (
                  <div className="text-sm" style={{ color: 'var(--fg-tertiary)' }}>None yet.</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {connAccounts.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between gap-3 py-1"
                        data-testid={`connected-account-${a.id}`}
                      >
                        <div className="min-w-0 text-base truncate" style={{ color: 'var(--fg-secondary)' }}>
                          <span className="font-medium" style={{ color: 'var(--fg-primary)' }}>{a.toolkit}</span>
                          {' — '}{a.appId}
                          {a.account !== 'default' && <span> · {a.account}</span>}
                          {a.status !== 'ACTIVE' && (
                            <span className="text-sm" style={{ color: 'var(--error)' }}> · {a.status.toLowerCase()}</span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => void removeConnectedAccount(a.id)}
                          disabled={connRemoving === a.id}
                          className="shrink-0 h-7 px-2 rounded cursor-pointer inline-flex items-center gap-1 text-sm border-0"
                          style={{
                            color: 'var(--fg-tertiary)',
                            background: 'transparent',
                            opacity: connRemoving === a.id ? 0.5 : 1,
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--error)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-tertiary)'; }}
                          aria-label={`Disconnect ${a.toolkit} from ${a.appId}`}
                          data-testid={`connected-account-remove-${a.id}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Secrets modal */}
      {secretsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.4)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setSecretsOpen(false); }}
          data-testid="secrets-modal-backdrop"
        >
          <div
            className="w-[480px] max-h-[80vh] overflow-y-auto rounded-lg p-6"
            style={{ background: 'var(--bg-white)', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}
            data-testid="secrets-modal"
          >
            <div className="mb-5">
              <h3 className="text-2xl font-bold" style={{ color: 'var(--fg-primary)' }}>
                {envApps.find((a) => a.appId === secretsApp)?.name ?? 'App'}
              </h3>
              <p className="mt-2 text-[16px]" style={{ color: 'var(--fg-secondary)' }}>
                Secrets are stored on this machine. Values never leave the Airglow daemon.
              </p>
            </div>
            {envError ? (
              <p className="text-base" style={{ color: 'var(--error)' }}>{envError}</p>
            ) : envApps.filter((a) => a.appId === secretsApp).length === 0 ? (
              <p className="text-base" style={{ color: 'var(--fg-tertiary)' }}>This app requires no secrets.</p>
            ) : (
              <div className="flex flex-col gap-6">
                {envApps
                  .filter((app) => app.appId === secretsApp)
                  .map((app) => (
                    <div key={app.appId} data-testid={`secrets-app-${app.appId}`}>
                      <div className="flex flex-col gap-3">
                        {app.keys.map(({ key, label, set, source, maskedTail }) => {
                          const inputKey = `${app.appId}:${key}`;
                          const visible = envVisible[inputKey] ?? false;
                          const fromEnvFile = set && source === 'env';
                          return (
                            <div key={key}>
                              <label className="text-base font-medium flex items-center gap-2" style={{ color: 'var(--fg-secondary)' }}>
                                {label || key}
                                {set ? (
                                  <span className="text-sm font-normal" style={{ color: 'var(--olive)' }} data-testid={`secret-status-${inputKey}`}>
                                    set{maskedTail ? ` (${maskedTail})` : ''}{fromEnvFile ? ' · from .env' : ''}
                                  </span>
                                ) : (
                                  <span className="text-sm font-normal" style={{ color: 'var(--error)' }} data-testid={`secret-status-${inputKey}`}>
                                    not set
                                  </span>
                                )}
                              </label>
                              <div className="text-sm mb-1" style={{ color: 'var(--fg-tertiary)' }}>{key}</div>
                              <div className="flex items-center gap-2">
                                <div className="relative flex-1">
                                  <input
                                    type={visible ? 'text' : 'password'}
                                    value={envInputs[inputKey] || ''}
                                    onChange={(e) => setEnvInputs((prev) => ({ ...prev, [inputKey]: e.target.value }))}
                                    placeholder={set ? (fromEnvFile ? 'Enter a value to override .env' : 'Enter new value to replace') : 'Enter value'}
                                    className="w-full h-10 px-3 pr-10 text-base rounded-sm border outline-none"
                                    style={{
                                      borderColor: 'var(--border-secondary)',
                                      background: 'var(--bg-primary)',
                                      color: 'var(--fg-primary)',
                                    }}
                                    data-testid={`secret-input-${inputKey}`}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => void revealEnv(app.appId, key, set)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded cursor-pointer"
                                    style={{ color: 'var(--fg-tertiary)' }}
                                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg-secondary)'; }}
                                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-tertiary)'; }}
                                    aria-label={visible ? 'Hide value' : 'Show value'}
                                  >
                                    {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                                  </button>
                                </div>
                                {set && source === 'ui' && (
                                  <button
                                    type="button"
                                    onClick={() => void postEnv(app.appId, { [key]: '' })}
                                    disabled={envSaving}
                                    className="h-10 px-3 rounded-md text-sm font-medium cursor-pointer border"
                                    style={{ color: 'var(--fg-tertiary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)' }}
                                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--error)'; e.currentTarget.style.borderColor = 'var(--error)'; }}
                                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-tertiary)'; e.currentTarget.style.borderColor = 'var(--border-secondary)'; }}
                                    data-testid={`secret-clear-${inputKey}`}
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setSecretsOpen(false)}
                className="h-10 px-5 rounded-md text-base font-medium cursor-pointer transition-all border"
                style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
              >
                Cancel
              </button>
              <button
                onClick={saveSecrets}
                disabled={!secretsChanged}
                className="h-10 px-5 rounded-md text-base font-medium transition-all border"
                style={{
                  color: 'var(--bg-white)',
                  borderColor: 'var(--clay)',
                  background: 'var(--clay)',
                  opacity: secretsChanged ? 1 : 0.4,
                  cursor: secretsChanged ? 'pointer' : 'not-allowed',
                }}
                onMouseEnter={(e) => { if (secretsChanged) e.currentTarget.style.opacity = '0.85'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = secretsChanged ? '1' : '0.4'; }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Blocking User Scripts gate — covers the whole dashboard until the
          Chrome permission is enabled (hard requirement, no dismiss). Gated on
          a session so the full-page sign-in gate keeps priority when both are
          unmet (documented order: sign-in before User Scripts). */}
      {authSession && <UserScriptsOverlay />}
    </div>
  );
}
