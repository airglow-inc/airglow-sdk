import { useState, useEffect, useRef } from 'react';
import { Trash2, RefreshCw, Power, Settings, KeyRound, AlertTriangle, Eye, EyeOff, AlertCircle, Info, Pin, FileCode2, TriangleAlert, ScrollText, Mail } from 'lucide-react';

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

const DEV_PORT_KEY = '__dev_port';
const APP_ORDER_KEY = '__app_order';
const LOGS_LAST_SEEN_KEY = '__logs_last_seen_ts';
const DEFAULT_DEV_PORT = 3222;

type AppVisibility = 'public' | 'development' | 'hidden';

interface AppManifest {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  secrets?: Record<string, { label?: string }>;
  visibility?: AppVisibility;
  _sourceType: 'local' | 'public';
}

interface SecretKey {
  key: string;
  label: string;
}

function isVisibleApp(app: AppManifest): boolean {
  return app.id !== 'dashboard' && app.visibility !== 'hidden';
}

function isPublishedApp(app: AppManifest): boolean {
  return app._sourceType === 'public' && (app.visibility ?? 'public') === 'public';
}

function isDevelopmentApp(app: AppManifest): boolean {
  return app._sourceType === 'public' && app.visibility === 'development';
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
  const [devPort, setDevPort] = useState(DEFAULT_DEV_PORT);
  const [portInput, setPortInput] = useState(String(DEFAULT_DEV_PORT));
  const [localOnline, setLocalOnline] = useState<boolean | null>(null);
  // null = native host disabled for this build (hide); true/false = liveness.
  const [nativeHostConnected, setNativeHostConnected] = useState<boolean | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSaved, setEmailSaved] = useState(false);
  const [unseenErrorCount, setUnseenErrorCount] = useState(0);

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
  const [isPinned, setIsPinned] = useState<boolean | null>(null);
  const [updateStatus, setUpdateStatus] = useState<{
    extension: { loaded: string | null; current: string | null; needsReload: boolean };
    repo: { local: string | null; upstream: string | null; behindUpstream: boolean };
  } | null>(null);

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

    let manifests: AppManifest[] = [];
    let online = false;
    try {
      const res = await fetch(`${localUrl}/api/apps/manifests`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const raw = await res.json();
      manifests = raw.map((m: any) => ({ ...m, _sourceType: 'local' as const }));
      online = true;
    } catch {
      online = false;
    }

    setLocalOnline(online);
    if (!online) {
      setError(true);
      setApps([]);
    } else {
      setError(false);
      const appsById = new Map<string, AppManifest>();
      for (const app of manifests) {
        if (!appsById.has(app.id)) appsById.set(app.id, app);
      }
      setApps(Array.from(appsById.values()).filter(isVisibleApp));
    }

    // Load manifests with settings from background + current secrets
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
    chrome.runtime.sendMessage({ type: 'airglow:get-manifests' }, (res) => {
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
    chrome.storage.local.get([DEV_PORT_KEY, '__disabled_apps', USER_EMAIL_KEY, APP_ORDER_KEY, '__native_host_connected'], (result) => {
      const port = (result[DEV_PORT_KEY] as number) || DEFAULT_DEV_PORT;
      const savedEmail = normalizeUserEmail(result[USER_EMAIL_KEY]) || '';
      const nh = result['__native_host_connected'];
      setNativeHostConnected(nh === undefined ? null : (nh as boolean));
      setDevPort(port);
      setPortInput(String(port));
      setDisabledApps(new Set((result['__disabled_apps'] || []) as string[]));
      setUserEmail(savedEmail || null);
      setEmailInput(savedEmail);
      if (result[APP_ORDER_KEY]) setAppOrder(result[APP_ORDER_KEY] as unknown as Record<string, string[]>);
      setIdentityLoaded(true);
      loadAll(port);
    });

    // Background polls the dev server every few seconds and writes the result
    // to __dev_server_online — react to transitions so the dashboard updates
    // live (no manual reload needed when the server comes back).
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('__dev_server_online' in changes) {
        chrome.storage.local.get(DEV_PORT_KEY, (r) => {
          loadAll(((r[DEV_PORT_KEY] as number) || DEFAULT_DEV_PORT));
        });
      }
      if (USER_EMAIL_KEY in changes) {
        const next = normalizeUserEmail(changes[USER_EMAIL_KEY].newValue) || '';
        setUserEmail(next || null);
        setEmailInput(next);
      }
      if ('__native_host_connected' in changes) {
        const v = changes['__native_host_connected'].newValue;
        setNativeHostConnected(v === undefined ? null : (v as boolean));
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
      setEmailSaved(true);
    });
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

  function toggleApp(appId: string) {
    const next = new Set(disabledApps);
    if (next.has(appId)) next.delete(appId);
    else next.add(appId);
    setDisabledApps(next);
    const arr = Array.from(next);
    chrome.storage.local.set({ '__disabled_apps': arr }, () => {
      chrome.runtime.sendMessage({ type: 'airglow:reload-app', appId });
    });
  }

  function appUrl(appId: string) {
    return chrome.runtime.getURL(`app-shell.html?app=${appId}`);
  }

  // ── Secrets modal ──

  function openSecrets() {
    chrome.runtime.sendMessage({ type: 'airglow:get-manifests' }, (res) => {
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

  // Compute missing secrets for an app
  function getMissingSecrets(appId: string): string[] {
    const manifest = fullManifests.find((m) => m.id === appId);
    if (!manifest?.secrets) return [];
    return Object.entries(manifest.secrets)
      .filter(([k]) => !userSecrets[k] && !devSecrets[k])
      .map(([k, v]) => `${v.label || k} (${k})`);
  }

  // Which apps need a specific key and it's missing?
  function getAppsNeedingKey(key: string): string[] {
    return fullManifests
      .filter((m) => !disabledApps.has(m.id) && m.secrets && key in m.secrets)
      .map((m) => `${m.name} (${m.id})`);
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
  const anyMissing = apps?.some((a) => !disabledApps.has(a.id) && getMissingSecrets(a.id).length > 0) ?? false;

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
    const missing = getMissingSecrets(app.id);
    const manifest = fullManifests.find((m) => m.id === app.id);
    const secrets = manifest?.secrets || app.secrets;
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
              {disabled && (
                <Badge color="var(--error)">Disabled</Badge>
              )}
              {!disabled && missing.length > 0 && (
                <Tooltip content={<span><strong>Missing secrets:</strong><br/>{missing.map(m => <span key={m}>&nbsp;&bull; {m}<br/></span>)}</span>}>
                  <Badge color="var(--error)" hoverable>
                    {missing.length} secret{missing.length > 1 ? 's' : ''} missing
                  </Badge>
                </Tooltip>
              )}
            </div>
            <a href={appUrl(app.id)} target="_blank" className="block text-base leading-relaxed no-underline" style={{ color: 'var(--fg-secondary)' }}>
              {app.description}
            </a>
          </div>
          <div className="flex flex-col gap-1.5 shrink-0 ml-3">
            <button
              onClick={() => toggleApp(app.id)}
              className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border"
              style={{
                color: disabled ? 'var(--bg-white)' : 'var(--bg-white)',
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

  const published = apps?.filter(isPublishedApp) || [];
  const development = apps?.filter(isDevelopmentApp) || [];
  const local = apps?.filter((a) => a._sourceType === 'local') || [];

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Sidebar */}
      <aside
        className="fixed top-0 left-0 h-screen w-[240px] flex flex-col z-30 border-r"
        style={{ background: 'var(--gray-150)', borderColor: 'var(--border-secondary)', boxShadow: '2px 0 8px rgba(0,0,0,0.04)' }}
      >
        {/* Logo */}
        <div className="px-5 pt-5 pb-6">
          <a
            href={chrome.runtime.getURL('dashboard.html')}
            onClick={(e) => { e.preventDefault(); setPage('apps'); }}
            className="inline-block cursor-pointer"
            data-testid="dashboard-logo"
          >
            <img src="/logo.svg" alt="Airglow" width={140} />
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
              Public Apps
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
                No public apps available
              </div>
            )}

            {sortByOrder(published, 'published').map((app, i) => (
              <a
                key={app.id}
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

          {/* Development section */}
          {development.length > 0 && (
            <div className="rounded-lg p-3" style={{ background: 'color-mix(in srgb, var(--sky) 8%, var(--bg-white))', border: '1px solid color-mix(in srgb, var(--sky) 20%, var(--border-tertiary))' }}>
              <div className="px-1 pb-2 text-2xl font-bold border-b" style={{ color: 'var(--sky)', borderColor: 'color-mix(in srgb, var(--sky) 20%, var(--border-tertiary))' }}>
                Under development
              </div>
              {sortByOrder(development, 'development').map((app, i) => (
                <a
                  key={app.id}
                  href={appUrl(app.id)} target="_blank"
                  className="block px-2 py-2.5 text-base cursor-pointer transition-colors font-medium no-underline"
                  style={{ color: 'var(--sky)', borderBottom: i < development.length - 1 ? '1px solid color-mix(in srgb, var(--sky) 15%, var(--border-tertiary))' : 'none' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--sky) 12%, var(--bg-tertiary))'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {app.name}
                </a>
              ))}
            </div>
          )}

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
                  key={app.id}
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
                  className="inline-flex items-center gap-1 text-base font-medium"
                  style={{ color: localOnline ? 'var(--olive)' : 'var(--error)' }}
                >
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full"
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
        <div className="px-5 py-4">
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
                Enter your email to continue
              </div>
              <p className="text-base mt-2 mb-4" style={{ color: 'var(--fg-secondary)' }}>
                Airglow needs an email on first launch so apps can identify this browser.
                It is stored locally in this extension.
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
        {(forceBanners || updateStatus?.repo.behindUpstream) && (
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
        {emailSaved && (
          <div
            className="p-4 rounded-[var(--radius-md)] mb-6 border text-base"
            style={{ background: 'color-mix(in srgb, var(--olive) 8%, var(--bg-white))', borderColor: 'color-mix(in srgb, var(--olive) 20%, var(--border-tertiary))', color: 'var(--fg-secondary)' }}
            data-testid="banner-email-saved"
          >
            Email saved locally: <strong>{userEmail}</strong>
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
              Public Apps
            </h2>
            {apps === null && (
              <div className="text-base py-8 text-center" style={{ color: 'var(--fg-tertiary)' }}>
                Loading...
              </div>
            )}
            {published.length === 0 && apps !== null ? (
              <div className="text-base py-8 text-center rounded-[var(--radius-md)]" style={{ color: 'var(--fg-tertiary)', border: '1px dashed var(--border-secondary)' }}>
                No public apps available
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {sortByOrder(published, 'published').map((app, i) => (
                  <AppCard key={app.id} app={app} section="published" index={i} list={published} />
                ))}
              </div>
            )}

            {development.length > 0 && (
              <div className="mt-8">
                <h3 className="text-xl font-bold tracking-tight mb-3" style={{ color: 'var(--sky)' }}>
                  Under development
                </h3>
                <div className="flex flex-col gap-4">
                  {sortByOrder(development, 'development').map((app, i) => (
                    <AppCard key={app.id} app={app} section="development" index={i} list={development} />
                  ))}
                </div>
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
                  <AppCard key={app.id} app={app} showReload section="local" index={i} list={local} />
                ))}
              </div>
            )}
          </div>
        </div>
        )}
        </>)}
      </main>

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
