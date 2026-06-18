import { Fragment, useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, RefreshCw, Power, Settings, KeyRound, AlertTriangle, Eye, EyeOff, TriangleAlert, ScrollText, MessageSquare, X, LayoutGrid, Store, ChevronRight, Globe, Copy, Check } from 'lucide-react';
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

const APP_ORDER_KEY = '__app_order';
const LOGS_LAST_SEEN_KEY = '__logs_last_seen_ts';
const SIDE_BUTTON_KEY = '__side_button_enabled';
type AppVisibility = 'public' | 'hidden';

interface AppManifest {
  id: string;
  name: string;
  description: string;
  server_env?: Record<string, { label?: string }>;
  visibility?: AppVisibility;
  // Daemon-injected: names of `server/*.ts` RPC handlers. Non-empty list
  // means RPC calls will fail when the daemon is down — surfaced as a
  // warning chip in the dashboard.
  _serverFunctions?: string[];
  version?: string;
}

// One app in the cloud catalog index (GET <cloud>/api/catalog).
interface CatalogApp {
  id: string;
  name: string;
  version: string;
  description: string;
}

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

// Hosts an app's own UI as a sandboxed iframe and bridges its SDK postMessages
// to the background — the single-shell replacement for the old app-shell.html
// page. The shell stamps the appId it loaded, so the iframe can't spoof another.
function AppFrame({ appId, origin, page }: { appId: string; origin: string; page?: string | null }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      const data: any = e.data;
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
  }, [appId]);
  const src = `${origin.replace(/\/+$/, '')}/api/apps/${appId}/ui?app=${encodeURIComponent(appId)}&embed=1${page ? `&page=${encodeURIComponent(page)}` : ''}`;
  return (
    <iframe
      ref={ref}
      key={appId}
      src={src}
      sandbox="allow-scripts allow-same-origin allow-forms"
      allow="clipboard-read; clipboard-write"
      style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
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
  const [installCopied, setInstallCopied] = useState(false);
  const [disabledApps, setDisabledApps] = useState<Set<string>>(new Set());
  const [localOnline, setLocalOnline] = useState<boolean | null>(null);
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
  const [activeTab, setActiveTab] = useState<'installed' | 'catalog'>('installed');
  const [catalogApps, setCatalogApps] = useState<CatalogApp[] | null>(null);
  const [provenance, setProvenance] = useState<Record<string, Provenance>>({});
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  // App pending uninstall confirmation (native in-page modal, not window.confirm).
  const [confirmUninstall, setConfirmUninstall] = useState<AppManifest | null>(null);

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Active inline setup banner ('pin' | null) reported by SetupBanners, and a
  // staged extension update (null when up to date). The pin banner renders as a
  // centered card; the update version drives the "Update" button by the version.
  const [dashSetup, setDashSetup] = useState<SetupStep | null>(null);
  const extUpdate = useExtUpdateAvailable();
  const hostVersion = useHostVersion();
  const [sideButtonEnabled, setSideButtonEnabled] = useState(false);
  const [gatewayUrlInput, setGatewayUrlInput] = useState('');
  // Host self-update state (Settings modal). null = not yet checked.
  const [hostUpdate, setHostUpdate] = useState<{
    current: string; latest: string | null; updateAvailable: boolean; mode: string;
  } | null>(null);
  const [hostUpdating, setHostUpdating] = useState(false);
  const [hostUpdateError, setHostUpdateError] = useState<string | null>(null);

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
    if (appId) _setPage('apps');
    const url = new URL(window.location.href);
    url.searchParams.delete('page');
    url.searchParams.delete('appPage');
    if (appId) url.searchParams.set('app', appId);
    else url.searchParams.delete('app');
    history.replaceState(null, '', url.toString());
  }

  // Honor ?page= for cross-surface navigation from an app page's sidebar
  // (Catalog / Settings; logs/apps are handled by the page initializer).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('page');
    if (p === 'catalog') { setActiveTab('catalog'); void loadCatalog(); }
    else if (p === 'settings') { setSettingsOpen(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closeable "dev server offline — running from cache" banner. Dismissal is
  // session-scoped: comes back on the next dashboard open so the user notices
  // again if the server is still down, but stays quiet within a session.
  const [offlineBannerDismissed, setOfflineBannerDismissed] = useState(
    () => sessionStorage.getItem('__airglow_offline_banner_dismissed') === '1',
  );

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
      const res = await fetch(`${cloud}/api/catalog`);
      const data = await res.json();
      if (Array.isArray(data?.apps)) setCatalogApps(data.apps);
    } catch { setCatalogApps([]); }
    await loadProvenance();
  }

  async function loadProvenance() {
    try {
      const origin = await getDaemonOrigin();
      const res = await fetch(`${origin}/api/catalog/installed`);
      const data = await res.json();
      if (data?.provenance) setProvenance(data.provenance);
    } catch { /* daemon down — handled elsewhere */ }
  }

  async function installCatalogApp(appId: string) {
    setInstalling(appId);
    try {
      const origin = await getDaemonOrigin();
      const res = await fetch(`${origin}/api/catalog/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId }),
      });
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || 'install failed');
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

  // Uninstall: delete the app's folder + daemon sidecars (provenance, secrets).
  // The opener just surfaces the in-page confirm modal; performUninstall does the work.
  async function performUninstall(app: AppManifest) {
    setConfirmUninstall(null);
    setUninstalling(app.id);
    try {
      const origin = await getDaemonOrigin();
      const res = await fetch(`${origin}/api/apps/uninstall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: app.id }),
      });
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || 'uninstall failed');
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
    chrome.storage.local.get(['__disabled_apps', APP_ORDER_KEY, '__native_host_connected', SIDE_BUTTON_KEY, CLOUD_API_URL_OVERRIDE_KEY], (result) => {
      const nh = result['__native_host_connected'];
      setNativeHostConnected(nh === undefined ? null : (nh as boolean));
      setDisabledApps(new Set((result['__disabled_apps'] || []) as string[]));
      if (result[APP_ORDER_KEY]) setAppOrder(result[APP_ORDER_KEY] as unknown as Record<string, string[]>);
      setSideButtonEnabled(!!result[SIDE_BUTTON_KEY]);
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
    };
    chrome.storage.local.onChanged.addListener(onChange);
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => {
    if (!identityLoaded || dashboardOpenTracked.current) return;
    dashboardOpenTracked.current = true;
    chrome.runtime.sendMessage({
      type: 'airglow:track-dashboard-opened',
      page,
    }, () => { void chrome.runtime.lastError; });
  }, [identityLoaded, page]);

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

  async function updateHost() {
    const origin = await daemonOrigin();
    if (!origin || !hostUpdate?.latest) return;
    setHostUpdating(true);
    setHostUpdateError(null);
    try {
      const res = await fetch(`${origin}/api/daemon/update`, { method: 'POST' });
      const body = await res.json();
      if (!body?.ok) throw new Error(String(body?.error ?? `daemon responded ${res.status}`));
      // The daemon swaps its binary and restarts; poll until the new version
      // answers (the port may change across the restart, so re-read origin).
      const target = body.updatingTo;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const o = (await daemonOrigin()) ?? origin;
          const s = await fetch(`${o}/api/healthz`).then((r) => r.json());
          if (s?.version === target) {
            setHostUpdate({ current: target, latest: target, updateAvailable: false, mode: 'binary' });
            setHostUpdating(false);
            return;
          }
        } catch {}
      }
      throw new Error('daemon did not come back — check state/daemon.log');
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

  function Badge({ children, color, hoverable }: { children: React.ReactNode; color: string; hoverable?: boolean }) {
    return (
      <span
        className={`text-sm font-medium px-1.5 py-0.5 rounded${hoverable ? ' cursor-help' : ''}`}
        style={{
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
      <div
        draggable={isDraggable}
        onDragStart={isDraggable ? () => handleDragStart(section, index) : undefined}
        onDragEnter={isDraggable ? () => handleDragEnter(section, index) : undefined}
        onDragEnd={isDraggable ? () => handleDragEnd(list, section) : undefined}
        onDragOver={isDraggable ? (e) => e.preventDefault() : undefined}
        className="rounded-[var(--radius-md)] p-5 transition-all border"
        style={{
          background: 'var(--bg-white)',
          borderColor: 'var(--border-tertiary)',
          boxShadow: 'var(--shadow-card)',
          cursor: isDraggable ? 'grab' : undefined,
        }}
      >
        <div className="text-lg font-semibold mb-1 flex items-center gap-2 flex-wrap" style={{ color: 'var(--fg-primary)' }}>
          <a
            href={appUrl(app.id)}
            onClick={(e) => { e.preventDefault(); openApp(app.id); }}
            className="no-underline cursor-pointer"
            style={{ color: 'inherit' }}
          >
            {app.name}
          </a>
          {disabled && (
            <Badge color="var(--error)">Disabled</Badge>
          )}
          {!disabled && missing.length > 0 && (
            <span onClick={() => openSecrets(app.id)} className="cursor-pointer" data-testid={`app-missing-secrets-${app.id}`}>
              <Tooltip content={<span><strong>Missing secrets — click to set:</strong><br/>{missing.map(m => <span key={m}>&nbsp;&bull; {m}<br/></span>)}</span>}>
                <Badge color="var(--error)" hoverable>
                  {missing.length} secret{missing.length > 1 ? 's' : ''} missing
                </Badge>
              </Tooltip>
            </span>
          )}
          {!disabled && localOnline === false && (app._serverFunctions?.length ?? 0) > 0 && (
            <Tooltip content={<span>This app may break when Dev server is down.</span>}>
              <Badge color="var(--error)" hoverable>
                Server down
              </Badge>
            </Tooltip>
          )}
          {prov ? (
            <Tooltip content={<span>Installed from the catalog{app.version ? ` (v${app.version})` : ''}.</span>}>
              <Badge color="#2f6fb3" hoverable>Catalog{app.version ? ` · v${app.version}` : ''}</Badge>
            </Tooltip>
          ) : (
            <Tooltip content={<span>Lives only in your local workspace — not installed from the catalog.</span>}>
              <Badge color="#1d4ed8" hoverable>Local</Badge>
            </Tooltip>
          )}
          {updateAvailable && (
            <Tooltip content={<span>A newer version (v{catalogEntry!.version}) is in the catalog. Reinstall from the Catalog tab to update.</span>}>
              <Badge color="var(--clay)" hoverable>Update → v{catalogEntry!.version}</Badge>
            </Tooltip>
          )}
          {prov?.modified && (
            <Tooltip content={<span>This catalog app has local edits since it was installed.</span>}>
              <Badge color="var(--olive)" hoverable>Modified</Badge>
            </Tooltip>
          )}
        </div>
        <a
          href={appUrl(app.id)}
          onClick={(e) => { e.preventDefault(); openApp(app.id); }}
          className="block text-base leading-relaxed no-underline cursor-pointer"
          style={{ color: 'var(--fg-secondary)' }}
        >
          {app.description}
        </a>
        {sites && (
          <div className="mt-2 flex items-center gap-1.5 text-sm" style={{ color: 'var(--fg-tertiary)' }} data-testid={`app-sites-${app.id}`}>
            <Globe size={15} />
            {sites.anyWebsite ? <span>Any website</span> : (
              <span className="truncate">{sites.hosts.map((h, i) => (<Fragment key={h}>{i > 0 && <span style={{ opacity: 0.45 }}>{' · '}</span>}{h}</Fragment>))}</span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 mt-4">
          <button
            onClick={() => toggleApp(app.id)}
            className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border"
            style={{
              color: 'var(--bg-white)',
              borderColor: disabled ? 'var(--success)' : 'var(--clay)',
              background: disabled ? 'var(--success)' : 'var(--clay)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
          >
            <Power size={15} />
            {disabled ? 'Enable' : 'Disable'}
          </button>
          <button
            onClick={() => setConfirmUninstall(app)}
            disabled={uninstalling === app.id}
            className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border"
            style={{
              color: 'var(--error)',
              borderColor: 'var(--border-secondary)',
              background: 'var(--bg-white)',
              opacity: uninstalling === app.id ? 0.6 : 1,
            }}
            onMouseEnter={(e) => { if (uninstalling !== app.id) e.currentTarget.style.background = 'color-mix(in srgb, var(--error) 8%, var(--bg-white))'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; }}
          >
            <Trash2 size={15} />
            {uninstalling === app.id ? 'Removing…' : 'Uninstall'}
          </button>
          {hasSecrets && (
            <button
              onClick={() => openSecrets(app.id)}
              className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border"
              style={{
                color: missing.length > 0 ? 'var(--error)' : 'var(--fg-secondary)',
                borderColor: missing.length > 0 ? 'color-mix(in srgb, var(--error) 45%, var(--border-secondary))' : 'var(--border-secondary)',
                background: 'var(--bg-white)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; }}
              data-testid={`app-secrets-${app.id}`}
            >
              <KeyRound size={15} />
              Secrets
            </button>
          )}
        </div>
      </div>
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
    const installedIds = new Set((apps || []).map((a) => a.id));
    return (
      <div className="flex flex-col gap-4">
        {catalogApps.map((c) => {
          const installed = installedIds.has(c.id);
          const installedApp = (apps || []).find((a) => a.id === c.id);
          const fromCatalog = !!provenance[c.id];
          const updatable = installed && !!installedApp?.version && isNewerVersion(c.version, installedApp.version);
          const busy = installing === c.id;
          const disabledBtn = busy || (installed && fromCatalog && !updatable);
          return (
            <div key={c.id} className="rounded-[var(--radius-md)] p-5 border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-tertiary)', boxShadow: 'var(--shadow-card)' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="text-lg font-semibold mb-1 flex items-center gap-2 flex-wrap" style={{ color: 'var(--fg-primary)' }}>
                    {c.name}
                    <span className="text-sm font-normal" style={{ color: 'var(--fg-tertiary)' }}>v{c.version}</span>
                    {installed && fromCatalog && !updatable && <Badge color="var(--success)">Installed</Badge>}
                    {installed && !fromCatalog && <Badge color="var(--fg-tertiary)">Installed locally</Badge>}
                    {updatable && <Badge color="var(--clay)">Update available</Badge>}
                  </div>
                  <div className="text-base leading-relaxed" style={{ color: 'var(--fg-secondary)' }}>{c.description}</div>
                  {installed && !fromCatalog && (
                    <div className="text-sm mt-2" style={{ color: 'var(--fg-tertiary)' }}>
                      A local app with this id exists — installing replaces it with the catalog version.
                    </div>
                  )}
                </div>
                <button
                  onClick={() => installCatalogApp(c.id)}
                  disabled={disabledBtn}
                  className="shrink-0 inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-md text-base font-medium border transition-all"
                  style={{
                    color: 'var(--bg-white)',
                    borderColor: 'var(--clay)',
                    background: 'var(--clay)',
                    opacity: disabledBtn ? 0.5 : 1,
                    cursor: disabledBtn ? 'default' : 'pointer',
                  }}
                  data-testid={`install-${c.id}`}
                >
                  {busy ? 'Installing…' : updatable ? 'Update' : installed ? (fromCatalog ? 'Installed' : 'Replace') : 'Install'}
                </button>
              </div>
            </div>
          );
        })}
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
    const missing = getMissingSecrets({ id: appId });
    const hasSecrets = (envApps.find((a) => a.appId === appId)?.keys.length ?? 0) > 0;
    const sites = appSites(app);
    const name = app?.name ?? appId;
    const btn = 'inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border';
    return (
      <div className="-m-8 flex flex-col overflow-hidden" style={{ height: '100vh' }}>
        <header className="shrink-0 px-8 pt-6 pb-6 border-b" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-tertiary)' }} data-testid="app-view-header">
          <nav className="inline-flex items-center gap-1.5 mb-5 text-base" style={{ color: 'var(--fg-tertiary)' }} data-testid="app-breadcrumb">
            <button type="button" onClick={() => openApp(null)} className="bg-transparent border-0 p-0 text-xl font-medium cursor-pointer" style={{ color: 'var(--fg-tertiary)' }}>Apps</button>
            <ChevronRight size={17} style={{ opacity: 0.6 }} />
            <span className="font-medium truncate" style={{ color: 'var(--fg-secondary)' }}>{name}</span>
          </nav>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-tight" style={{ color: 'var(--fg-primary)' }} data-testid="app-page-title">{name}</h1>
            {disabled && <Badge color="var(--error)">Disabled</Badge>}
            {prov
              ? <Badge color="var(--sky)">Catalog{app?.version ? ` · v${app.version}` : ''}</Badge>
              : <Badge color="#1d4ed8">Local</Badge>}
            {prov?.modified && <Badge color="var(--olive)">Modified</Badge>}
          </div>
          {app?.description && <p className="mt-1.5 text-[15px] leading-relaxed max-w-2xl" style={{ color: 'var(--fg-secondary)' }}>{app.description}</p>}
          {sites && (
            <div className="mt-2 flex items-center gap-1.5 text-sm" style={{ color: 'var(--fg-tertiary)' }} data-testid="app-sites">
              <Globe size={15} />
              {sites.anyWebsite ? <span>Any website</span> : (
                <span className="truncate">
                  {sites.hosts.map((h, i) => (<Fragment key={h}>{i > 0 && <span style={{ opacity: 0.45 }}>{' · '}</span>}{h}</Fragment>))}
                </span>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 mt-4">
            <button onClick={() => toggleApp(appId)} className={btn} style={{ color: 'var(--bg-white)', borderColor: disabled ? 'var(--success)' : 'var(--clay)', background: disabled ? 'var(--success)' : 'var(--clay)' }} data-testid="app-toggle">
              <Power size={15} />{disabled ? 'Enable' : 'Disable'}
            </button>
            <button onClick={() => app && setConfirmUninstall(app)} className={btn} style={{ color: 'var(--error)', borderColor: 'var(--border-secondary)', background: 'var(--bg-white)' }} data-testid="app-uninstall">
              <Trash2 size={15} />Uninstall
            </button>
            {hasSecrets && (
              <button onClick={() => openSecrets(appId)} className={btn} style={{ color: missing.length > 0 ? 'var(--error)' : 'var(--fg-secondary)', borderColor: missing.length > 0 ? 'color-mix(in srgb, var(--error) 45%, var(--border-secondary))' : 'var(--border-secondary)', background: 'var(--bg-white)' }} data-testid="app-secrets">
                <KeyRound size={15} />Secrets
              </button>
            )}
          </div>
        </header>
        <div className="flex-1 min-h-0" style={{ background: 'var(--bg-primary)' }}>
          {daemonOriginUrl
            ? <AppFrame appId={appId} origin={daemonOriginUrl} page={appPage} />
            : <div className="p-8 text-base" style={{ color: 'var(--fg-tertiary)' }}>Loading…</div>}
        </div>
      </div>
    );
  }

  // Focused popup (openApp({ window: true })): just the app frame, full-viewport,
  // no sidebar/header. The frame still bridges the app's SDK to the background,
  // so app_ui calls (storage, llm, captureTab) work as they do in-dashboard.
  if (chromeless && openAppId) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: 'var(--bg-primary)' }}>
        {daemonOriginUrl
          ? <AppFrame appId={openAppId} origin={daemonOriginUrl} page={appPage} />
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
          onClick={(e) => { e.preventDefault(); openApp(null); setActiveTab('installed'); setPage('apps'); }}
          className="px-5 pt-5 pb-4 flex items-center gap-2.5 no-underline cursor-pointer"
          data-testid="dashboard-logo"
        >
          <img src={logoUrl} alt="Airglow" width={34} height={34} />
          <span className="text-xl font-bold tracking-tight" style={{ color: 'var(--fg-primary)' }}>Airglow</span>
        </a>

        {/* Primary nav */}
        <nav className="flex-1 overflow-y-scroll flex flex-col gap-0.5 px-3 pt-1 sidebar-scroll">
          <NavRow
            icon={LayoutGrid}
            label="Apps"
            active={page === 'apps' && !openAppId && activeTab === 'installed'}
            onClick={() => { openApp(null); setActiveTab('installed'); setPage('apps'); }}
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
            onClick={() => { openApp(null); setActiveTab('catalog'); setPage('apps'); void loadCatalog(); }}
            badge={catalogApps ? <span className="text-sm font-normal" style={{ color: 'var(--fg-tertiary)' }}>{catalogApps.length}</span> : null}
            testId="nav-catalog"
          />
          <NavRow
            icon={ScrollText}
            label="Logs"
            active={page === 'logs'}
            disabled={!authSession}
            title={!authSession ? 'Sign in to view logs' : undefined}
            onClick={() => { if (authSession) { openApp(null); setPage('logs'); } }}
            badge={unseenErrorCount > 0 && page !== 'logs'
              ? <span className="inline-flex items-center gap-1 text-sm font-semibold tabular-nums" style={{ color: 'var(--error)' }} data-testid="logs-unseen-badge"><AlertTriangle size={16} />{unseenErrorCount > 99 ? '99+' : unseenErrorCount}</span>
              : null}
            testId="nav-logs"
          />
        </nav>

        {/* Footer card: server status, Settings, cloud + version */}
        <div className="px-3 pb-2 pt-2">
          <div className="rounded-lg p-2" style={{ background: 'var(--bg-white)', border: '1px solid var(--border-tertiary)' }}>
            <div className="px-2 pt-1 pb-2.5" data-testid="local-apps-status">
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--fg-tertiary)' }}>
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: localOnline === null ? 'var(--fg-tertiary)' : localOnline ? 'var(--olive)' : 'var(--error)' }} />
                <span><span style={{ color: 'var(--olive)', fontWeight: 600 }}>Host</span> {localOnline === null ? '…' : localOnline ? 'online' : 'offline'}</span>
              </div>
              {nativeHostConnected === false && (
                <div className="flex items-center gap-2 mt-1 text-sm" style={{ color: 'var(--error)' }} data-testid="native-host-status">
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: 'var(--error)' }} />
                  Native host offline
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
            <div className="px-2 pt-1 flex items-center gap-2 flex-wrap" style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>
              <span>v{chrome.runtime.getManifest().version}{hostVersion ? ` (host v${hostVersion})` : ''}</span>
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
            </div>
          </div>
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
          <AppView appId={openAppId} />
        ) : (
        <div className="-m-8 flex flex-col" style={{ minHeight: '100vh' }}>
          <header className="shrink-0 px-8 pt-6 pb-6 border-b" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-tertiary)' }}>
            <div className="flex items-center gap-1.5 text-base" data-testid="dashboard-breadcrumb">
              <span className="text-xl font-medium" style={{ color: 'var(--fg-secondary)' }}>{activeTab === 'catalog' ? 'Catalog' : 'Apps'}</span>
              {activeTab === 'catalog' && catalogApps && (
                <span className="text-lg" style={{ color: 'var(--fg-tertiary)' }}>{catalogApps.length}</span>
              )}
            </div>
          </header>
          <div className="p-8">
        {/* Dev server offline — running from cached source. Closeable; the
            bottom-left status pill already shows the underlying offline state.
            (The User Scripts / pin setup banners moved to the sidepanel —
            see components/SetupBanners.tsx.) */}
        {localOnline === false && apps !== null && apps.length > 0 && !offlineBannerDismissed && (
          <div
            className="relative p-5 rounded-[var(--radius-md)] mb-6 border w-fit mx-auto"
            style={{
              background: 'color-mix(in srgb, var(--error) 8%, var(--bg-white))',
              borderColor: 'color-mix(in srgb, var(--error) 30%, var(--border-tertiary))',
            }}
            data-testid="banner-dev-server-offline-cached"
          >
            <button
              onClick={() => {
                sessionStorage.setItem('__airglow_offline_banner_dismissed', '1');
                setOfflineBannerDismissed(true);
              }}
              className="absolute top-2 right-2 inline-flex items-center justify-center h-8 w-8 rounded cursor-pointer border"
              style={{ background: 'var(--bg-white)', color: 'var(--fg-secondary)', borderColor: 'color-mix(in srgb, var(--error) 30%, var(--border-tertiary))' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--fg-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; e.currentTarget.style.color = 'var(--fg-secondary)'; }}
              aria-label="Dismiss"
              data-testid="banner-dev-server-offline-cached-dismiss"
            >
              <X size={16} strokeWidth={2.5} />
            </button>
            <div>
              <div className="text-lg font-semibold flex items-center gap-2 pr-8" style={{ color: 'var(--fg-primary)' }}>
                <TriangleAlert size={20} style={{ color: 'var(--error)' }} />
                Local Apps server is offline
              </div>
              <div className="mt-4 text-base" style={{ color: 'var(--fg-secondary)', maxWidth: '560px' }}>
                Only userscripts will work — app UIs and server functions are disabled.
                The server starts automatically when the Airglow native host is connected.
              </div>
            </div>
          </div>
        )}

        {error ? (
          <div className="min-h-[calc(100vh-200px)] flex items-center justify-center">
            <div
              className="text-center max-w-[520px] p-8 rounded-[var(--radius-md)] border"
              style={{
                background: 'color-mix(in srgb, var(--error) 8%, var(--bg-white))',
                borderColor: 'color-mix(in srgb, var(--error) 30%, var(--border-tertiary))',
              }}
              data-testid="banner-dev-server-offline"
            >
              <div className="flex justify-center mb-4">
                <div
                  className="rounded-full p-4 inline-flex"
                  style={{ background: 'color-mix(in srgb, var(--error) 18%, var(--bg-white))' }}
                >
                  <TriangleAlert size={48} style={{ color: 'var(--error)' }} />
                </div>
              </div>
              <div className="text-2xl font-bold mb-2" style={{ color: 'var(--fg-primary)' }}>
                Local Apps server offline
              </div>
              <p className="text-base mb-3" style={{ color: 'var(--fg-secondary)' }}>
                Run this command to install the host:
              </p>
              <div className="inline-flex items-stretch gap-2 max-w-full">
                <code
                  className="px-2.5 py-1.5 rounded-md font-mono text-[13px] whitespace-nowrap overflow-x-auto"
                  style={{ background: 'var(--gray-150)', color: 'var(--fg-primary)' }}
                >
                  curl -fsSL https://airglow.dev/install.sh | bash
                </code>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText('curl -fsSL https://airglow.dev/install.sh | bash').then(() => {
                      setInstallCopied(true);
                      setTimeout(() => setInstallCopied(false), 1500);
                    });
                  }}
                  title={installCopied ? 'Copied' : 'Copy'}
                  className="shrink-0 inline-flex items-center justify-center w-9 rounded-md cursor-pointer"
                  style={{ background: 'var(--gray-150)', color: 'var(--fg-secondary)' }}
                >
                  {installCopied ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </div>
              <button
                onClick={() => loadAll()}
                className="mt-5 h-10 px-5 rounded-md text-base font-medium cursor-pointer border transition-colors inline-flex items-center gap-2"
                style={{ borderColor: 'var(--error)', color: 'var(--error)', background: 'transparent' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--error) 10%, transparent)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                data-testid="retry-dev-server"
              >
                <RefreshCw size={16} />
                Retry
              </button>
            </div>
          </div>
        ) : (
        <div
          className={dashSetup === 'pin' ? 'flex items-center justify-center' : 'max-w-3xl'}
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
                  <button onClick={() => { setActiveTab('catalog'); void loadCatalog(); }} className="underline cursor-pointer" style={{ color: 'var(--clay)' }}>Catalog</button>{' '}to add one.
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {sortByOrder(local, 'local').map((app, i) => (
                    <AppCard key={app.id} app={app} section="local" index={i} list={local} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <CatalogView />
          ))}
        </div>
        )}
          </div>
        </div>
        )}
      </main>

      <button
        onClick={() => setFeedbackOpen(true)}
        className="fixed right-5 bottom-5 z-40 h-12 px-4 rounded-full text-base font-medium cursor-pointer transition-all border inline-flex items-center gap-2"
        style={{
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

      {/* Feedback modal */}
      {/* Uninstall confirmation modal (replaces window.confirm) */}
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
              This deletes the app's folder and any saved secrets. This cannot be undone.
            </p>
            <div
              className="mt-3 px-3 py-2 rounded-md text-sm font-mono break-all"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--fg-primary)' }}
              data-testid="uninstall-path"
            >
              apps/{confirmUninstall.id}
            </div>
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
            className="w-[420px] rounded-lg p-6"
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
            <div className="py-2 flex items-center justify-between gap-4" data-testid="settings-host-version-row">
              <div>
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
              </div>
              {hostUpdate?.updateAvailable && hostUpdate.mode === 'binary' && (
                <button
                  type="button"
                  onClick={updateHost}
                  disabled={hostUpdating}
                  className="shrink-0 h-9 px-4 text-base font-medium rounded-sm cursor-pointer border-0"
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
                {envApps.find((a) => a.appId === secretsApp)?.name ?? 'App'} · Secrets
              </h3>
              <p className="text-sm mt-1" style={{ color: 'var(--fg-tertiary)' }}>
                Stored on this machine. Values never leave the Airglow daemon.
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
