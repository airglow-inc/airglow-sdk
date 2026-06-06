import { type FormEvent, useState, useEffect, useRef } from 'react';
import { Trash2, RefreshCw, Power, Settings, KeyRound, AlertTriangle, Eye, EyeOff, AlertCircle, Info, Pin, FileCode2, TriangleAlert, ScrollText, Mail, MessageSquare, Send, X } from 'lucide-react';
import logoUrl from '../../lib/branding/logo.svg';

// Chrome's "Extensions" toolbar icon — Material Symbols "extension" (outlined).
// (Apache 2.0, https://fonts.google.com/icons?icon.query=extension)
function PuzzleIcon({ size = 16, color = 'currentColor', className = '' }: { size?: number; color?: string; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 -960 960 960" fill={color} className={className} aria-hidden="true">
      <path d="M352-120H200q-33 0-56.5-23.5T120-200v-152q48 0 84-30.5t36-77.5q0-47-36-77.5T120-568v-152q0-33 23.5-56.5T200-800h160q0-42 29-71t71-29q42 0 71 29t29 71h160q33 0 56.5 23.5T800-720v160q42 0 71 29t29 71q0 42-29 71t-71 29v160q0 33-23.5 56.5T720-120H568q0-50-31.5-85T460-240q-45 0-76.5 35T352-120Zm-152-80h85q24-66 77-93t98-27q45 0 98 27t77 93h85v-240h80q8 0 14-6t6-14q0-8-6-14t-14-6h-80v-240H480v-80q0-8-6-14t-14-6q-8 0-14 6t-6 14v80H200v88q54 20 87 67t33 105q0 57-33 104t-87 68v88Zm260-260Z" />
    </svg>
  );
}
import LogsPage from './LogsPage';
import { normalizeUserEmail, USER_EMAIL_KEY } from '../../lib/airglow-identity';
import { getCloudAppSourceUrl } from '../../lib/app-source-config';

const DEV_PORT_KEY = '__dev_port';
const APP_ORDER_KEY = '__app_order';
const LOGS_LAST_SEEN_KEY = '__logs_last_seen_ts';
const FEEDBACK_VISITOR_ID_KEY = '__airglow_feedback_visitor_id';
const DEFAULT_DEV_PORT = 3222;
const FEEDBACK_TIMEOUT_MS = 8000;

type FeedbackKind = 'general' | 'bug' | 'idea';
type FeedbackStatus = { type: 'info' | 'success' | 'error'; text: string };
type PublicRuntimeConfig = {
  appServerUrl?: string;
  enableFeedback?: boolean;
  feedbackEndpoint?: string;
};

async function getFeedbackVisitorId(): Promise<string> {
  const stored = await chrome.storage.local.get(FEEDBACK_VISITOR_ID_KEY);
  const existing = typeof stored[FEEDBACK_VISITOR_ID_KEY] === 'string' ? stored[FEEDBACK_VISITOR_ID_KEY] : '';
  if (existing) return existing;
  const next = crypto.randomUUID();
  await chrome.storage.local.set({ [FEEDBACK_VISITOR_ID_KEY]: next });
  return next;
}

async function getFeedbackEndpoint(): Promise<string> {
  const baseUrl = getCloudAppSourceUrl();
  const fallbackEndpoint = new URL('/api/feedback', `${baseUrl}/`).toString();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/config`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    });
  } catch {
    return fallbackEndpoint;
  }
  if (!res.ok) return fallbackEndpoint;

  let config: PublicRuntimeConfig;
  try {
    config = await res.json() as PublicRuntimeConfig;
  } catch {
    return fallbackEndpoint;
  }
  if (config.enableFeedback === false) throw new Error('Feedback is disabled.');

  const endpoint = config.feedbackEndpoint || '/api/feedback';
  const endpointBase = (config.appServerUrl || baseUrl).replace(/\/+$/, '');
  return new URL(endpoint, `${endpointBase}/`).toString();
}

type AppVisibility = 'public' | 'development' | 'hidden';

type AppSourceType = 'local' | 'cloud';

interface AppManifest {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  secrets?: Record<string, { label?: string }>;
  visibility?: AppVisibility;
  _sourceType: AppSourceType;
  // Dev-server-injected: names of `server/*.ts` RPC handlers. Non-empty list
  // means RPC calls will fail when the dev server is down — surfaced as a
  // warning chip in the dashboard.
  _serverFunctions?: string[];
}

interface SecretKey {
  key: string;
  label: string;
}

function isVisibleApp(app: AppManifest): boolean {
  return app.id !== 'dashboard';
}

function isCloudApp(app: AppManifest): boolean {
  return app._sourceType === 'cloud';
}

// Inventory keys both copies of an app that exists in local + cloud sources.
// React keys use this so both rows render side-by-side without collision.
function appIdentityKey(app: Pick<AppManifest, 'id' | '_sourceType'>): string {
  return `${app._sourceType}:${app.id}`;
}

type AppSourceOverrides = Record<string, 'local' | 'cloud'>;

// Which source actually owns the runtime slot for `appId`. Local wins by
// default on collision; an override flips the winner.
function activeSourceForApp(
  appId: string,
  inventory: AppManifest[] | null,
  overrides: AppSourceOverrides,
): 'local' | 'cloud' {
  const override = overrides[appId];
  if (override) return override;
  const hasLocal = Boolean(inventory?.some((m) => m.id === appId && m._sourceType === 'local'));
  return hasLocal ? 'local' : 'cloud';
}

// True when an other-source copy of this appId exists AND that other copy is
// the one actually running. The row gets a "Use this version" button to flip
// the override.
function isShadowed(app: AppManifest, inventory: AppManifest[] | null, overrides: AppSourceOverrides): boolean {
  const hasOther = Boolean(inventory?.some((m) => m.id === app.id && m._sourceType !== app._sourceType));
  if (!hasOther) return false;
  return activeSourceForApp(app.id, inventory, overrides) !== app._sourceType;
}

export default function App() {
  const [page, _setPage] = useState<'apps' | 'logs'>(() => {
    const p = new URLSearchParams(window.location.search).get('page');
    return p === 'logs' ? 'logs' : 'apps';
  });
  const forceBanners = new URLSearchParams(window.location.search).get('debug-banners') === '1';
  function setPage(p: 'apps' | 'logs') {
    _setPage(p);
    const url = new URL(window.location.href);
    if (p === 'apps') url.searchParams.delete('page');
    else url.searchParams.set('page', p);
    history.replaceState(null, '', url.toString());
  }
  const [apps, setApps] = useState<AppManifest[] | null>(null);
  const [error, setError] = useState(false);
  const [reloadingApp, setReloadingApp] = useState<string | null>(null);
  const [disabledApps, setDisabledApps] = useState<Set<string>>(new Set());
  const [sourceOverrides, setSourceOverrides] = useState<AppSourceOverrides>({});
  const [devPort, setDevPort] = useState(DEFAULT_DEV_PORT);
  const [portInput, setPortInput] = useState(String(DEFAULT_DEV_PORT));
  const [localOnline, setLocalOnline] = useState<boolean | null>(null);
  // null = native host disabled for this build (hide); true/false = liveness.
  const [nativeHostConnected, setNativeHostConnected] = useState<boolean | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [unseenErrorCount, setUnseenErrorCount] = useState(0);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind>('general');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackStatus | null>(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);

  // Secrets state
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [secretKeys, setSecretKeys] = useState<SecretKey[]>([]);
  const [userSecrets, setUserSecrets] = useState<Record<string, string>>({});
  const [devSecrets, setDevSecrets] = useState<Record<string, string>>({});
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [secretVisible, setSecretVisible] = useState<Record<string, boolean>>({});
  const [fullManifests, setFullManifests] = useState<AppManifest[]>([]);

  // Setup banners
  const [userScriptsEnabled, setUserScriptsEnabled] = useState<boolean | null>(null);
  // Closeable "dev server offline — running from cache" banner. Dismissal is
  // session-scoped: comes back on the next dashboard open so the user notices
  // again if the server is still down, but stays quiet within a session.
  const [offlineBannerDismissed, setOfflineBannerDismissed] = useState(
    () => sessionStorage.getItem('__airglow_offline_banner_dismissed') === '1',
  );
  const [isPinned, setIsPinned] = useState<boolean | null>(null);
  const [updateStatus, setUpdateStatus] = useState<{
    extension: { loaded: string | null; current: string | null; needsReload: boolean };
    // local/upstream are build timestamps (ms); behindUpstream fires only when
    // upstream is strictly later, so a local-only rebuild won't trip the prompt.
    repo: { local: number | null; upstream: number | null; behindUpstream: boolean };
  } | null>(null);
  // Server-independent "git pull" signal — the background checks origin/main's
  // extension/manifest.json hash on a 60-min alarm and persists the result so
  // the dashboard banner stays in lockstep with the toolbar badge even when
  // the dev server is offline.
  const [gitPullDueRemote, setGitPullDueRemote] = useState<boolean>(false);

  // Drag-and-drop reorder
  const [appOrder, setAppOrder] = useState<Record<string, string[]>>({});
  const dragItem = useRef<{ section: string; index: number } | null>(null);
  const dragOverItem = useRef<{ section: string; index: number } | null>(null);

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

  useEffect(() => {
    // Detect User Scripts
    if (chrome.userScripts) {
      chrome.userScripts.getScripts().then(() => setUserScriptsEnabled(true))
        .catch(() => setUserScriptsEnabled(false));
    } else {
      setUserScriptsEnabled(false);
    }

    // Detect pinned state
    chrome.action?.getUserSettings?.().then((s) => setIsPinned(s.isOnToolbar));

  }, []);

  async function loadAll(port?: number) {
    const localUrl = `http://127.0.0.1:${port ?? devPort}`;

    // The background loader runs against both local + cloud sources and
    // persists the inventory. Read the dev-server-online flag and the inventory
    // in one round-trip instead of re-fetching manifests ourselves.
    const [stored, manifestRes] = await Promise.all([
      chrome.storage.local.get('__dev_server_online'),
      chrome.runtime.sendMessage({ type: 'airglow:get-dashboard-manifests' }).catch(() => null),
    ]);
    const manifests: AppManifest[] = Array.isArray(manifestRes?.manifests) ? manifestRes.manifests : [];
    const online = Boolean(stored['__dev_server_online']);

    setLocalOnline(online);
    setError(!online && manifests.length === 0);
    setApps(manifests.filter(isVisibleApp));

    loadSecretsState();

    if (online) {
      fetchUpdateStatus(localUrl).then(setUpdateStatus).catch(() => setUpdateStatus(null));
    } else {
      setUpdateStatus(null);
    }
  }

  async function fetchUpdateStatus(localUrl: string) {
    // Chrome caches manifest.json at extension load time, so getManifest()
    // returns the hash that was stamped into the loaded version — stable
    // across SW restarts and not affected by on-disk edits until the user
    // explicitly reloads the extension.
    const loadedHash = (chrome.runtime.getManifest() as { airglow_build_hash?: string }).airglow_build_hash || null;
    const qs = loadedHash ? `?extensionBuildHash=${encodeURIComponent(loadedHash)}` : '';
    const res = await fetch(`${localUrl}/api/extension/update-status${qs}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }

  function loadSecretsState() {
    chrome.runtime.sendMessage({ type: 'airglow:get-dashboard-manifests' }, (res) => {
      if (res?.manifests) setFullManifests(res.manifests);
    });
    chrome.runtime.sendMessage({ type: 'airglow:secrets:get-all' }, (res) => {
      if (res) {
        setUserSecrets(res.userSecrets);
        setDevSecrets(res.devSecrets);
      }
    });
  }

  function savePort(newPort: number) {
    setDevPort(newPort);
    chrome.storage.local.set({ [DEV_PORT_KEY]: newPort }, () => {
      chrome.runtime.sendMessage({ type: 'airglow:reload-apps' });
      loadAll(newPort);
    });
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
    chrome.storage.local.get([DEV_PORT_KEY, '__disabled_apps', '__app_source_override', USER_EMAIL_KEY, APP_ORDER_KEY, '__native_host_connected', '__git_pull_due_remote'], (result) => {
      const port = (result[DEV_PORT_KEY] as number) || DEFAULT_DEV_PORT;
      const savedEmail = normalizeUserEmail(result[USER_EMAIL_KEY]) || '';
      const nh = result['__native_host_connected'];
      setNativeHostConnected(nh === undefined ? null : (nh as boolean));
      setDevPort(port);
      setPortInput(String(port));
      setDisabledApps(new Set((result['__disabled_apps'] || []) as string[]));
      setSourceOverrides((result['__app_source_override'] as AppSourceOverrides | undefined) || {});
      setUserEmail(savedEmail || null);
      setEmailInput(savedEmail);
      if (result[APP_ORDER_KEY]) setAppOrder(result[APP_ORDER_KEY] as unknown as Record<string, string[]>);
      setGitPullDueRemote(!!result['__git_pull_due_remote']);
      setIdentityLoaded(true);
      loadAll(port);
    });

    // Background polls the dev server every few seconds and writes the result
    // to __dev_server_online — react to transitions so the dashboard updates
    // live (no manual reload needed when the server comes back).
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('__dev_server_online' in changes || '__app_inventory_manifests' in changes || '__app_manifests' in changes) {
        chrome.storage.local.get(DEV_PORT_KEY, (r) => {
          loadAll(((r[DEV_PORT_KEY] as number) || DEFAULT_DEV_PORT));
        });
      }
      if (USER_EMAIL_KEY in changes) {
        const next = normalizeUserEmail(changes[USER_EMAIL_KEY].newValue) || '';
        setUserEmail(next || null);
        setEmailInput(next);
        chrome.runtime.sendMessage({ type: 'airglow:reload-apps' }, () => { void chrome.runtime.lastError; });
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
      if ('__app_source_override' in changes) {
        setSourceOverrides((changes['__app_source_override'].newValue as AppSourceOverrides | undefined) || {});
      }
      // Background's 60-min remote-manifest check writes this; keep the
      // banner in sync with the toolbar badge.
      if ('__git_pull_due_remote' in changes) {
        setGitPullDueRemote(!!changes['__git_pull_due_remote'].newValue);
      }
    };
    chrome.storage.local.onChanged.addListener(onChange);
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, []);

  // Poll the dev server's update-status endpoint while the server is online so
  // the "Reload Airglow" banner appears without the user having to refresh the
  // dashboard. Pauses while offline (no point hitting a dead server) and while
  // the dashboard tab is hidden (saves a request per ~5s when nobody's looking).
  useEffect(() => {
    if (localOnline !== true) return;
    const localUrl = `http://127.0.0.1:${devPort}`;
    let cancelled = false;
    const tick = () => {
      if (document.hidden) return;
      fetchUpdateStatus(localUrl)
        .then((r) => { if (!cancelled) setUpdateStatus(r); })
        .catch(() => { /* transient failure — next tick will retry */ });
    };
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [localOnline, devPort]);

  function saveUserEmail() {
    const trimmed = normalizeUserEmail(emailInput);
    if (!trimmed) {
      setEmailError('Enter a valid email address.');
      return;
    }
    chrome.storage.local.set({ [USER_EMAIL_KEY]: trimmed }, () => {
      setUserEmail(trimmed);
      setEmailInput(trimmed);
      setEmailError(null);
      chrome.runtime.sendMessage({ type: 'airglow:reload-apps' }, () => {
        void chrome.runtime.lastError;
        loadAll();
      });
    });
  }

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (feedbackSubmitting) return;

    const message = feedbackMessage.trim();
    if (message.length < 3) {
      setFeedbackStatus({ type: 'error', text: 'Add at least 3 characters.' });
      return;
    }
    setFeedbackSubmitting(true);
    setFeedbackStatus({ type: 'info', text: 'Sending…' });
    try {
      const visitorId = await getFeedbackVisitorId();
      const endpoint = await getFeedbackEndpoint();
      const stored = await chrome.storage.local.get([USER_EMAIL_KEY]);
      const userEmail = normalizeUserEmail(stored[USER_EMAIL_KEY]);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitorId,
          userEmail,
          kind: feedbackKind,
          message,
          appId: 'dashboard',
          appName: 'Airglow Dashboard',
          sourceType: 'extension-dashboard',
        }),
        signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
      });

      if (!res.ok) {
        let detail = `Feedback HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (typeof body?.error === 'string') detail = body.error;
        } catch {}
        throw new Error(detail);
      }

      setFeedbackStatus({ type: 'success', text: 'Sent. Thank you.' });
      setFeedbackMessage('');
    } catch (error) {
      setFeedbackStatus({
        type: 'error',
        text: error instanceof Error ? error.message : 'Could not send feedback.',
      });
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  function reloadApp(appId: string) {
    setReloadingApp(appId);
    chrome.runtime.sendMessage({ type: 'airglow:reload-app', appId }, () => {
      setReloadingApp(null);
    });
  }

  function clearStorage(appId: string) {
    chrome.runtime.sendMessage({ type: 'airglow:clear-app-storage', appId }, (res) => {
      if (res?.ok) alert(`Cleared ${res.removed} storage entries for ${appId}`);
    });
  }

  // Click "Use this version" on a shadowed row: tell background to set the
  // override so this row's source wins runtime. Cloud → sourceType: 'cloud'.
  // Local → sourceType: null (clears override; local is the default).
  function setSourceOverride(app: AppManifest) {
    const sourceType = app._sourceType === 'cloud' ? 'cloud' : null;
    chrome.runtime.sendMessage({ type: 'airglow:set-source-override', appId: app.id, sourceType });
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
    return chrome.runtime.getURL(`app-shell.html?app=${appId}`);
  }

  // ── Secrets modal ──

  function openSecrets() {
    chrome.runtime.sendMessage({ type: 'airglow:get-dashboard-manifests' }, (res) => {
      const manifests: AppManifest[] = res?.manifests || [];

      chrome.runtime.sendMessage({ type: 'airglow:secrets:get-all' }, (secretsRes) => {
        const us: Record<string, string> = secretsRes?.userSecrets || {};
        const ds: Record<string, string> = secretsRes?.devSecrets || {};

        // Union of client-scoped keys from enabled apps
        const keyMap = new Map<string, string>();
        for (const m of manifests) {
          if (disabledApps.has(m.id)) continue;
          if (!m.secrets) continue;
          for (const [k, v] of Object.entries(m.secrets)) {
            if (!keyMap.has(k)) {
              keyMap.set(k, v.label || k);
            }
          }
        }

        const keys = [...keyMap.entries()].map(([key, label]) => ({ key, label }));
        setSecretKeys(keys);
        setUserSecrets(us);
        setDevSecrets(ds);

        const inputs: Record<string, string> = {};
        for (const { key } of keys) {
          inputs[key] = us[key] ?? '';
        }
        setSecretInputs(inputs);
        setSecretsOpen(true);
      });
    });
  }

  function saveSecrets() {
    const toSave: Record<string, string> = {};
    for (const { key } of secretKeys) {
      toSave[key] = secretInputs[key]?.trim() || '';
    }
    chrome.runtime.sendMessage({ type: 'airglow:secrets:save', secrets: toSave }, () => {
      loadSecretsState();
    });
  }

  // Compute missing secrets for an app. Source-qualified lookup so a
  // cloud+local pair of the same id don't pick each other's manifest.
  function getMissingSecrets(app: Pick<AppManifest, 'id' | '_sourceType' | 'secrets'>): string[] {
    const manifest = fullManifests.find((m) => m.id === app.id && m._sourceType === app._sourceType)
      || apps?.find((m) => m.id === app.id && m._sourceType === app._sourceType)
      || app;
    if (!manifest?.secrets) return [];
    return Object.entries(manifest.secrets)
      .filter(([k]) => !userSecrets[k] && !devSecrets[k])
      .map(([k, v]) => `${v.label || k} (${k})`);
  }

  // Which apps need a specific key and it's missing? Dedupe by appId since
  // the inventory may contain two copies — only one runs, so list it once.
  function getAppsNeedingKey(key: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const m of fullManifests) {
      if (disabledApps.has(m.id)) continue;
      if (!m.secrets || !(key in m.secrets)) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      result.push(`${m.name} (${m.id})`);
    }
    return result;
  }

  function isKeyMissing(key: string): boolean {
    return !userSecrets[key] && !devSecrets[key];
  }

  // Check if secrets modal has unsaved changes
  const secretsChanged = secretKeys.some(({ key }) => {
    const current = (secretInputs[key] || '').trim();
    const saved = userSecrets[key] || '';
    return current !== saved;
  });

  // Any enabled app has missing secrets?
  const anyMissing = apps?.some((a) => !disabledApps.has(a.id) && getMissingSecrets(a).length > 0) ?? false;

  function Badge({ children, color, hoverable }: { children: React.ReactNode; color: string; hoverable?: boolean }) {
    return (
      <span
        className={`text-sm font-medium px-1.5 py-0.5 rounded${hoverable ? ' cursor-help' : ''}`}
        style={{
          background: `color-mix(in srgb, ${color} 12%, transparent)`,
          color,
          border: hoverable ? `0.5px solid ${color}` : undefined,
        }}
      >
        {children}
      </span>
    );
  }

  function Tooltip({ children, content }: { children: React.ReactNode; content: React.ReactNode }) {
    const [show, setShow] = useState(false);
    const ref = useRef<HTMLSpanElement>(null);
    const hideTimeout = useRef<ReturnType<typeof setTimeout>>(null);
    return (
      <span
        ref={ref}
        className="relative inline-flex"
        onMouseEnter={() => { if (hideTimeout.current) clearTimeout(hideTimeout.current); setShow(true); }}
        onMouseLeave={() => { hideTimeout.current = setTimeout(() => setShow(false), 200); }}
      >
        {children}
        {show && (
          <span
            className="absolute bottom-full left-1/2 -translate-x-1/2 pb-1.5"
          >
            <span
              className="block px-3 py-2 text-base rounded-md z-50 border font-normal select-text cursor-text"
              style={{ background: 'var(--bg-white)', color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', whiteSpace: 'nowrap' }}
            >
              {content}
            </span>
          </span>
        )}
      </span>
    );
  }

  function AppCard({ app, showReload, section, index, list }: { app: AppManifest; showReload?: boolean; section?: string; index?: number; list?: AppManifest[] }) {
    const disabled = disabledApps.has(app.id);
    const missing = getMissingSecrets(app);
    const manifest = fullManifests.find((m) => m.id === app.id && m._sourceType === app._sourceType);
    const secrets = manifest?.secrets || app.secrets;
    const isDraggable = section !== undefined && index !== undefined && list !== undefined;
    const shadowed = isShadowed(app, apps, sourceOverrides);
    // When the OTHER source is currently winning, this row is shadowed.
    // The "Use this version" button flips the override.
    const otherSource: 'local' | 'cloud' = app._sourceType === 'local' ? 'cloud' : 'local';
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
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="text-lg font-semibold mb-1 flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
              <a href={appUrl(app.id)} target="_blank" className="no-underline" style={{ color: 'inherit' }}>{app.name}</a>
              {secrets && Object.keys(secrets).length > 0 && (
                <Tooltip content={
                  <span>
                    <strong>Required secrets:</strong><br/>
                    {Object.entries(secrets).map(([k, v]) => (
                      <span key={k}>&nbsp;&bull; {v.label || k} ({k})<br/></span>
                    ))}
                  </span>
                }>
                  <span
                    className="inline-flex items-center justify-center rounded-sm border"
                    style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)', width: 32, height: 32, cursor: 'help' }}
                  >
                    <Info size={17} />
                  </span>
                </Tooltip>
              )}
              {shadowed && (
                <Tooltip content={<span>The {otherSource} copy with the same id is currently running. Click "Use this version" to switch.</span>}>
                  <Badge color="var(--sky)" hoverable>Shadowed by {otherSource}</Badge>
                </Tooltip>
              )}
              {disabled && (
                <Badge color="var(--error)">Disabled</Badge>
              )}
              {!disabled && !shadowed && missing.length > 0 && (
                <Tooltip content={<span><strong>Missing secrets:</strong><br/>{missing.map(m => <span key={m}>&nbsp;&bull; {m}<br/></span>)}</span>}>
                  <Badge color="var(--error)" hoverable>
                    {missing.length} secret{missing.length > 1 ? 's' : ''} missing
                  </Badge>
                </Tooltip>
              )}
              {!disabled && app._sourceType === 'local' && localOnline === false && (app._serverFunctions?.length ?? 0) > 0 && (
                <Tooltip content={<span>This app may break when Dev server is down.</span>}>
                  <Badge color="var(--error)" hoverable>
                    Server down
                  </Badge>
                </Tooltip>
              )}
            </div>
            <a href={appUrl(app.id)} target="_blank" className="block text-base leading-relaxed no-underline" style={{ color: 'var(--fg-secondary)' }}>
              {app.description}
            </a>
          </div>
          <div className="flex flex-col gap-1.5 shrink-0 ml-3">
            {/* Shadowed rows: only a single "Use this version" button so the user
                can flip the override. All other actions (Disable/Clear/Reload)
                are on the active row. */}
            {shadowed && (
              <button
                onClick={() => setSourceOverride(app)}
                className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border"
                style={{ color: 'var(--bg-white)', borderColor: 'var(--sky)', background: 'var(--sky)' }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
              >
                Use this version
              </button>
            )}
            {!shadowed && (
              <>
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
                  onClick={() => clearStorage(app.id)}
                  className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border"
                  style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
                >
                  <Trash2 size={15} />
                  Clear
                </button>
                {showReload && (
                  <button
                    onClick={() => reloadApp(app.id)}
                    disabled={reloadingApp === app.id}
                    className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border"
                    style={{ color: 'var(--bg-white)', borderColor: 'var(--olive)', background: 'var(--olive)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                  >
                    <RefreshCw size={15} />
                    {reloadingApp === app.id ? 'Reloading...' : 'Reload'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {app.tags?.length ? (
          <div className="flex gap-1.5 mt-3 flex-wrap">
            {app.tags.map((t) => (
              <span key={t} className="text-xs px-2 py-0.5 rounded-[var(--radius-xs)]" style={{ background: 'var(--bg-tertiary)', color: 'var(--fg-secondary)' }}>
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const published = apps?.filter(isCloudApp) || [];
  const local = apps?.filter((a) => a._sourceType === 'local') || [];

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Sidebar */}
      <aside
        className="fixed top-0 left-0 h-screen w-[240px] flex flex-col z-30 border-r"
        style={{ background: 'var(--gray-150)', borderColor: 'var(--border-secondary)', boxShadow: '2px 0 8px rgba(0,0,0,0.04)' }}
      >
        {/* Logo */}
        <div className="px-5 pt-5 pb-6 flex justify-center">
          <a
            href={chrome.runtime.getURL('dashboard.html')}
            onClick={(e) => { e.preventDefault(); setPage('apps'); }}
            className="inline-block cursor-pointer"
            data-testid="dashboard-logo"
          >
            <img src={logoUrl} alt="Airglow" width={170} />
          </a>
        </div>

        {/* App lists */}
        <nav className="flex-1 overflow-y-scroll flex flex-col gap-3 sidebar-scroll" style={{ paddingLeft: '12px', paddingRight: '8px' }}>
          {/* Apps section */}
          <div className="rounded-lg p-3" style={{ background: 'var(--bg-white)', border: '1px solid var(--border-tertiary)' }}>
            <div
              className="px-1 pb-2 text-2xl font-bold border-b cursor-pointer"
              style={{ color: 'var(--fg-primary)', borderColor: 'var(--border-tertiary)' }}
              onClick={() => setPage('apps')}
            >
              Cloud Apps
            </div>

            {error && (
              <div className="px-1 py-3 text-sm" style={{ color: 'var(--fg-tertiary)' }}>
                Dev server offline
              </div>
            )}

            {!error && apps === null && (
              <div className="px-1 py-3 text-sm" style={{ color: 'var(--fg-tertiary)' }}>
                Loading...
              </div>
            )}

            {published.length === 0 && apps !== null && !error && (
              <div className="px-1 py-3 text-sm" style={{ color: 'var(--fg-tertiary)' }}>
                No cloud apps available
              </div>
            )}

            {sortByOrder(published, 'published').map((app, i) => (
              <a
                key={appIdentityKey(app)}
                href={appUrl(app.id)} target="_blank"
                className="block px-2 py-2.5 text-base cursor-pointer transition-colors font-medium no-underline"
                style={{ color: 'var(--fg-secondary)', borderBottom: i < published.length - 1 ? '1px solid var(--border-tertiary)' : 'none' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--fg-primary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-secondary)'; }}
              >
                {app.name}
              </a>
            ))}
          </div>

          {/* Local section */}
          {apps !== null && (
            <div className="rounded-lg p-3" style={{ background: 'color-mix(in srgb, var(--olive) 8%, var(--bg-white))', border: '1px solid color-mix(in srgb, var(--olive) 20%, var(--border-tertiary))' }}>
              <div className="px-1 pb-2 text-2xl font-bold border-b" style={{ color: 'var(--olive)', borderColor: 'color-mix(in srgb, var(--olive) 20%, var(--border-tertiary))' }}>
                Local Apps
              </div>

              {local.length === 0 && (
                <div className="px-1 py-3 text-sm" style={{ color: 'var(--fg-tertiary)' }}>
                  No local apps
                </div>
              )}

              {sortByOrder(local, 'local').map((app, i) => (
                <a
                  key={appIdentityKey(app)}
                  href={appUrl(app.id)} target="_blank"
                  className="block px-2 py-2.5 text-base cursor-pointer transition-colors font-medium no-underline"
                  style={{ color: 'var(--olive)', borderBottom: i < local.length - 1 ? '1px solid color-mix(in srgb, var(--olive) 15%, var(--border-tertiary))' : 'none' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--olive) 12%, var(--bg-tertiary))'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {app.name}
                </a>
              ))}
            </div>
          )}
        </nav>

        {/* Settings */}
        <div className="px-3 pb-1 pt-3">
          <div className="rounded-lg p-3" style={{ background: 'var(--bg-white)', border: '1px solid var(--border-tertiary)' }}>
            <div className="flex items-center gap-1.5 px-1 pb-2 text-base font-semibold border-b" style={{ color: 'var(--fg-tertiary)', borderColor: 'var(--border-tertiary)' }}>
              <Settings size={16} />
              Settings
            </div>
            <div className="px-1 pt-2.5">
              <label className="text-base font-medium" style={{ color: 'var(--fg-tertiary)' }}><span style={{ color: 'var(--olive)', fontWeight: 600 }}>Local Apps</span> server port</label>
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={portInput}
                  onChange={(e) => { if (/^\d*$/.test(e.target.value)) setPortInput(e.target.value); }}
                  onFocus={(e) => { const len = e.target.value.length; e.target.setSelectionRange(len, len); }}
                  onBlur={() => {
                    const n = parseInt(portInput, 10);
                    if (n > 0 && n < 65536 && n !== devPort) savePort(n);
                    else setPortInput(String(devPort));
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  className="w-20 h-8 px-2 text-base rounded-sm border outline-none"
                  style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)', color: 'var(--fg-primary)' }}
                  data-testid="dev-port-input"
                />
                <span
                  className="inline-flex items-center gap-1.5 text-lg font-medium"
                  style={{ color: localOnline ? 'var(--olive)' : 'var(--error)' }}
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ background: localOnline === null ? 'var(--fg-tertiary)' : localOnline ? 'var(--olive)' : 'var(--error)' }}
                  />
                  {localOnline === null ? '' : localOnline ? 'Online' : 'Offline'}
                </span>
              </div>
            </div>
            {/* Only surfaced when the debug bridge is down; silent when connected or disabled. */}
            {nativeHostConnected === false && (
              <div className="px-1 pt-2.5" data-testid="native-host-status">
                <div className="flex items-center gap-1.5 text-base font-medium" style={{ color: 'var(--error)' }}>
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: 'var(--error)' }} />
                  Native host offline
                </div>
              </div>
            )}
            <div className="px-1 pt-3 flex flex-col gap-1.5">
              <button
                onClick={openSecrets}
                className="w-full h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border flex items-center gap-1.5"
                style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
                data-testid="secrets-button"
              >
                <KeyRound size={14} />
                Secrets
                {anyMissing && (
                  <AlertTriangle size={18} style={{ color: 'var(--error)', marginLeft: 'auto' }} />
                )}
              </button>
              <button
                onClick={() => setPage('logs')}
                className="w-full h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border flex items-center gap-1.5"
                style={{
                  color: page === 'logs' ? 'var(--bg-white)' : 'var(--fg-secondary)',
                  borderColor: page === 'logs' ? 'var(--fg-secondary)' : 'var(--border-secondary)',
                  background: page === 'logs' ? 'var(--fg-secondary)' : 'var(--bg-primary)',
                }}
                onMouseEnter={(e) => { if (page !== 'logs') e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { if (page !== 'logs') e.currentTarget.style.background = 'var(--bg-primary)'; }}
                data-testid="logs-button"
              >
                <ScrollText size={14} />
                Logs
                {unseenErrorCount > 0 && page !== 'logs' && (
                  <span
                    className="inline-flex items-center gap-1 ml-auto text-sm font-semibold tabular-nums"
                    style={{ color: 'var(--error)' }}
                    data-testid="logs-unseen-badge"
                  >
                    <AlertTriangle size={18} />
                    {unseenErrorCount > 99 ? '99+' : unseenErrorCount}
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Tagline */}
        <div className="px-5 py-4 text-center">
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
        ) : !userEmail ? (
          <div className="min-h-[calc(100vh-64px)] flex items-center justify-center">
            <div
              className="w-full max-w-[520px] p-6 rounded-[var(--radius-md)] border"
              style={{
                background: 'var(--bg-white)',
                borderColor: 'var(--border-tertiary)',
                boxShadow: 'var(--shadow-card)',
              }}
              data-testid="banner-email-onboarding"
            >
              <div className="text-lg font-semibold flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
                <Mail size={20} style={{ color: 'var(--clay)' }} />
                Enter your email
              </div>
              <p className="text-base mt-2 mb-4" style={{ color: 'var(--fg-secondary)' }}>
                Airglow asks for an email to identify its users. We promise to never send any spam.
              </p>
              <div className="flex flex-col gap-3">
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => { setEmailInput(e.target.value); setEmailError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveUserEmail(); }}
                  placeholder="you@example.com"
                  className="w-full h-11 px-3 text-base rounded-sm border outline-none"
                  style={{ borderColor: emailError ? 'var(--error)' : 'var(--border-secondary)', background: 'var(--bg-primary)', color: 'var(--fg-primary)' }}
                  data-testid="user-email-input"
                  autoFocus
                />
                {emailError && (
                  <div className="text-sm" style={{ color: 'var(--error)' }}>{emailError}</div>
                )}
                <button
                  onClick={saveUserEmail}
                  className="h-11 px-5 rounded-md text-base font-medium cursor-pointer transition-all border"
                  style={{ color: 'var(--bg-white)', borderColor: 'var(--clay)', background: 'var(--clay)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                  data-testid="save-user-email-button"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        ) : page === 'logs' ? (
          <LogsPage />
        ) : (<>
        {/* Dev server offline — running from cached source. Closeable; the
            bottom-left status pill already shows the underlying offline state.
            Mirrors the "Enable User Scripts" treatment so error banners look
            consistent across the dashboard. */}
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
                (Local Apps) Dev server is offline
              </div>
              <div className="mt-4 text-base" style={{ color: 'var(--fg-secondary)', maxWidth: '560px' }}>
                Only userscripts will work, UI and Server functions are disabled. Run{' '}
                <code className="px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>pnpm airglow dev</code>
                {' '}to start the server.
              </div>
            </div>
          </div>
        )}

        {/* Setup banners */}
        {(forceBanners || updateStatus?.extension.needsReload) && (
          <div
            className="p-4 rounded-[var(--radius-md)] mb-6 border-2 flex items-center gap-4 w-fit mx-auto"
            style={{
              background: 'color-mix(in srgb, var(--olive) 10%, var(--bg-white))',
              borderColor: 'var(--olive)',
              color: 'var(--fg-secondary)',
            }}
            data-testid="banner-extension-reload"
          >
            <div className="text-lg font-semibold flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
              New Airglow version is available on disk
            </div>
            <button
              onClick={async () => {
                await chrome.storage.local.set({ __reopen_dashboard_after_reload: true });
                chrome.runtime.reload();
              }}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-md text-base font-medium cursor-pointer transition-all border shrink-0"
              style={{ background: 'var(--olive)', borderColor: 'var(--olive)', color: 'var(--bg-white)' }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
              data-testid="banner-reload-airglow-button"
            >
              <RefreshCw size={16} />
              Reload Airglow
            </button>
          </div>
        )}
        {(forceBanners || updateStatus?.repo.behindUpstream || gitPullDueRemote) && (
          <div
            className="p-4 rounded-[var(--radius-md)] mb-6 border text-base w-fit mx-auto"
            style={{
              background: 'color-mix(in srgb, var(--sky) 8%, var(--bg-white))',
              borderColor: 'color-mix(in srgb, var(--sky) 30%, var(--border-tertiary))',
              color: 'var(--fg-secondary)',
            }}
            data-testid="banner-repo-update"
          >
            <div className="text-lg font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
              <Info size={20} style={{ color: 'var(--sky)' }} /> A newer Airglow SDK is available
            </div>
            <div className="flex flex-col gap-1.5 text-base" style={{ color: 'var(--fg-secondary)' }}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--sky) 22%, var(--bg-white))', color: 'color-mix(in srgb, var(--sky) 60%, var(--gray-950))' }}>1</span>
                Run <code>git pull</code> in <code>airglow-sdk/</code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--sky) 22%, var(--bg-white))', color: 'color-mix(in srgb, var(--sky) 60%, var(--gray-950))' }}>2</span>
                Reload the extension
              </div>
            </div>
          </div>
        )}
        {(forceBanners || userScriptsEnabled === false) && (
          <div
            className="p-5 rounded-[var(--radius-md)] mb-6 border w-fit mx-auto"
            style={{
              background: 'color-mix(in srgb, var(--error) 8%, var(--bg-white))',
              borderColor: 'color-mix(in srgb, var(--error) 30%, var(--border-tertiary))',
            }}
            data-testid="banner-userscripts"
          >
            <div>
              <div className="text-lg font-semibold flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
                <FileCode2 size={20} style={{ color: 'var(--error)' }} />
                Enable User Scripts
              </div>
              <div className="flex flex-col gap-1.5 mt-4 text-base" style={{ color: 'var(--fg-secondary)' }}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--error) 22%, var(--bg-white))', color: 'var(--error)' }}>1</span>
                  Open{' '}
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }); }}
                    style={{ color: 'var(--clay)' }}
                  >Extension Settings</a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--error) 22%, var(--bg-white))', color: 'var(--error)' }}>2</span>
                  Scroll down and enable <strong>User scripts</strong>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--error) 22%, var(--bg-white))', color: 'var(--error)' }}>3</span>
                  Reload this page
                </div>
              </div>
              <div
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full border-2"
                style={{ borderColor: 'var(--error)', background: 'color-mix(in srgb, var(--error) 18%, var(--bg-white))', color: 'var(--fg-secondary)', fontSize: '15px' }}
              >
                <TriangleAlert size={17} className="shrink-0" style={{ color: 'var(--error)' }} />
                <span>Airglow won't run until User Scripts are enabled.</span>
              </div>
            </div>
          </div>
        )}

        {(forceBanners || isPinned === false) && (
          <div
            className="p-5 rounded-[var(--radius-md)] mb-6 border w-fit mx-auto"
            style={{
              background: 'color-mix(in srgb, var(--error) 8%, var(--bg-white))',
              borderColor: 'color-mix(in srgb, var(--error) 30%, var(--border-tertiary))',
            }}
            data-testid="banner-pin"
          >
            <div>
              <div className="text-lg font-semibold flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
                <Pin size={20} style={{ color: 'var(--error)' }} />
                Add Airglow shortcut
              </div>
              <div className="flex flex-col gap-1.5 mt-4 text-base" style={{ color: 'var(--fg-secondary)' }}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--error) 22%, var(--bg-white))', color: 'var(--error)' }}>1</span>
                  <span className="inline-flex items-center gap-1.5">
                    Click <PuzzleIcon size={20} className="inline-block shrink-0" color="var(--fg-primary)" /> icon <strong>(Extensions)</strong> in Chrome's toolbar
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--error) 22%, var(--bg-white))', color: 'var(--error)' }}>2</span>
                  <span className="inline-flex items-center gap-1.5">
                    Click <Pin size={20} className="inline-block shrink-0" style={{ color: 'var(--fg-primary)' }} /> icon next to <strong>Airglow</strong>
                  </span>
                </div>
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
                Dev server offline
              </div>
              <p className="text-base" style={{ color: 'var(--fg-secondary)' }}>
                Run{' '}
                <code
                  className="px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
                >
                  pnpm airglow dev
                </code>{' '}
                to start the dev server on port{' '}
                <code
                  className="px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--fg-primary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
                >
                  {devPort}
                </code>{' '}
                and load your apps.
              </p>
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
        <div className="grid grid-cols-2 gap-8 items-start">
          {/* Apps column */}
          <div>
            <h2 className="text-2xl font-bold tracking-tight mb-4" style={{ color: 'var(--fg-primary)' }}>
              Cloud Apps
            </h2>
            {apps === null && (
              <div className="text-base py-8 text-center" style={{ color: 'var(--fg-tertiary)' }}>
                Loading...
              </div>
            )}
            {published.length === 0 && apps !== null ? (
              <div className="text-base py-8 text-center rounded-[var(--radius-md)]" style={{ color: 'var(--fg-tertiary)', border: '1px dashed var(--border-secondary)' }}>
                No cloud apps available
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {sortByOrder(published, 'published').map((app, i) => (
                  <AppCard key={appIdentityKey(app)} app={app} section="published" index={i} list={published} />
                ))}
              </div>
            )}

          </div>

          {/* Local column */}
          <div>
            <h2 className="text-2xl font-bold tracking-tight mb-4" style={{ color: 'var(--olive)' }}>
              Local Apps
            </h2>
            {local.length === 0 && apps !== null ? (
              <div className="text-base py-8 text-center rounded-[var(--radius-md)]" style={{ color: 'var(--fg-tertiary)', border: '1px dashed var(--border-secondary)' }}>
                No local apps running
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {sortByOrder(local, 'local').map((app, i) => (
                  <AppCard key={appIdentityKey(app)} app={app} showReload section="local" index={i} list={local} />
                ))}
              </div>
            )}
          </div>
        </div>
        )}
        </>)}
      </main>

      <button
        onClick={() => {
          setFeedbackOpen(true);
          setFeedbackStatus(null);
        }}
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
      {feedbackOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-end p-5"
          style={{ background: 'rgba(28,25,23,0.18)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setFeedbackOpen(false); }}
          data-testid="feedback-modal-backdrop"
        >
          <form
            onSubmit={submitFeedback}
            className="w-full max-w-[420px] rounded-lg p-5 border"
            style={{
              background: 'var(--bg-white)',
              borderColor: 'var(--border-tertiary)',
              boxShadow: '0 16px 40px rgba(28,25,23,.18)',
              color: 'var(--fg-primary)',
            }}
            data-testid="feedback-modal"
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-sm mb-1" style={{ color: 'var(--fg-tertiary)' }}>Airglow feedback</div>
                <div className="text-lg font-semibold" style={{ color: 'var(--fg-primary)' }}>What should we fix or improve?</div>
              </div>
              <button
                type="button"
                onClick={() => setFeedbackOpen(false)}
                className="h-8 w-8 rounded-md cursor-pointer inline-flex items-center justify-center"
                style={{ color: 'var(--fg-tertiary)', background: 'transparent', border: 0 }}
                aria-label="Close feedback"
              >
                <X size={18} />
              </button>
            </div>
            <select
              value={feedbackKind}
              onChange={(e) => setFeedbackKind(e.target.value as FeedbackKind)}
              className="w-full h-9 px-3 mb-2 text-base rounded-sm border outline-none"
              style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)', color: 'var(--fg-primary)' }}
              data-testid="feedback-kind"
            >
              <option value="general">General</option>
              <option value="bug">Bug</option>
              <option value="idea">Idea</option>
            </select>
            <textarea
              required
              minLength={3}
              maxLength={2000}
              value={feedbackMessage}
              onChange={(e) => setFeedbackMessage(e.target.value)}
              placeholder="Short note. Please don't paste secrets, prompts, or page content."
              className="w-full min-h-[120px] p-3 text-base rounded-sm border outline-none resize-y"
              style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)', color: 'var(--fg-primary)' }}
              data-testid="feedback-message"
              autoFocus
            />
            <div
              className="min-h-[20px] mt-2 text-sm"
              style={{
                color: feedbackStatus?.type === 'error'
                  ? 'var(--error)'
                  : feedbackStatus?.type === 'success'
                    ? 'var(--olive)'
                    : 'var(--fg-secondary)',
              }}
              data-testid="feedback-status"
            >
              {feedbackStatus?.text || ''}
            </div>
            <button
              type="submit"
              disabled={feedbackSubmitting || feedbackMessage.trim().length < 3}
              className="mt-2 h-9 px-4 rounded-md text-base font-medium transition-all border inline-flex items-center gap-2"
              style={{
                color: 'var(--bg-white)',
                borderColor: 'var(--clay)',
                background: 'var(--clay)',
                opacity: feedbackSubmitting || feedbackMessage.trim().length < 3 ? 0.45 : 1,
                cursor: feedbackSubmitting || feedbackMessage.trim().length < 3 ? 'not-allowed' : 'pointer',
              }}
              data-testid="feedback-submit"
            >
              <Send size={15} />
              {feedbackSubmitting ? 'Sending…' : 'Send feedback'}
            </button>
          </form>
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
              <h3 className="text-2xl font-bold" style={{ color: 'var(--fg-primary)' }}>Secrets</h3>
              {userEmail && (
                <p className="text-sm mt-1" style={{ color: 'var(--fg-tertiary)' }} data-testid="secrets-modal-email">
                  Registered as <strong style={{ color: 'var(--fg-secondary)' }}>{userEmail}</strong>
                </p>
              )}
            </div>
            {secretKeys.length === 0 ? (
              <p className="text-base" style={{ color: 'var(--fg-tertiary)' }}>No apps require secrets.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {secretKeys.map(({ key, label }) => {
                  const isDevProvided = !!devSecrets[key] && !userSecrets[key];
                  const missing = isKeyMissing(key);
                  const appsNeeding = getAppsNeedingKey(key);
                  const visible = secretVisible[key] ?? false;
                  return (
                    <div key={key}>
                      <label className="text-lg font-medium flex items-center gap-2" style={{ color: 'var(--fg-secondary)' }}>
                        {label}
                        {isDevProvided && (
                          <span className="text-sm" style={{ color: 'var(--olive)' }}>(from .env)</span>
                        )}
                        {missing && (
                          <Tooltip content={<span><strong>Required by:</strong><br/>{appsNeeding.map(a => <span key={a}>&nbsp;&bull; {a}<br/></span>)}</span>}>
                            <AlertCircle size={18} style={{ color: 'var(--error)', cursor: 'help' }} />
                          </Tooltip>
                        )}
                      </label>
                      <div className="relative mt-1">
                        <input
                          type={visible ? 'text' : 'password'}
                          value={isDevProvided ? (visible ? devSecrets[key] : '••••••••') : (secretInputs[key] || '')}
                          disabled={isDevProvided}
                          onChange={(e) => setSecretInputs((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder={isDevProvided ? '' : 'Not set'}
                          className="w-full h-10 px-3 pr-10 text-base rounded-sm border outline-none"
                          style={{
                            borderColor: 'var(--border-secondary)',
                            background: isDevProvided ? 'var(--bg-tertiary)' : 'var(--bg-primary)',
                            color: 'var(--fg-primary)',
                            opacity: isDevProvided ? 0.7 : 1,
                            cursor: isDevProvided ? 'not-allowed' : undefined,
                          }}
                          data-testid={`secret-input-${key}`}
                        />
                        {(secretInputs[key] || isDevProvided) && (
                          <button
                            type="button"
                            onClick={() => setSecretVisible((prev) => ({ ...prev, [key]: !prev[key] }))}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded cursor-pointer"
                            style={{ color: 'var(--fg-tertiary)' }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg-secondary)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-tertiary)'; }}
                          >
                            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
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
    </div>
  );
}
