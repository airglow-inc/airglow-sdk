import React, { useEffect, useState } from 'react';
import { Settings, ExternalLink } from 'lucide-react';
import {
  getDashboardManifests,
  openApp,
  openDashboard,
  type SourcedManifest,
} from '../lib/appShellBridge';
// esbuild loads .svg as text (dev server passes --loader:.svg=text)
import logoSvg from '../assets/logo.svg';

const LOGO_URI = 'data:image/svg+xml;utf8,' + encodeURIComponent(logoSvg);

type LocalManifest = { id: string; name: string; visibility?: string };

function visible<T extends { visibility?: string }>(apps: T[]): T[] {
  return apps.filter((a) => a.visibility !== 'hidden');
}

function AppLink({
  name,
  active,
  last,
  olive,
  onClick,
  testId,
}: {
  name: string;
  active?: boolean;
  last: boolean;
  olive?: boolean;
  onClick?: () => void;
  testId: string;
}) {
  const baseColor = olive ? 'var(--olive)' : 'var(--fg-secondary)';
  const hoverBg = olive
    ? 'color-mix(in srgb, var(--olive) 12%, var(--bg-tertiary))'
    : 'var(--bg-tertiary)';
  const divider = olive
    ? '1px solid color-mix(in srgb, var(--olive) 15%, var(--border-tertiary))'
    : '1px solid var(--border-tertiary)';
  return (
    <a
      data-testid={testId}
      onClick={(e) => {
        e.preventDefault();
        onClick?.();
      }}
      className={`block px-2 py-2.5 text-base cursor-pointer transition-colors no-underline ${active ? 'font-bold' : 'font-medium'}`}
      style={{
        color: active && !olive ? 'var(--fg-primary)' : baseColor,
        background: active ? hoverBg : 'transparent',
        borderBottom: last ? 'none' : divider,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = hoverBg;
        if (!olive) e.currentTarget.style.color = 'var(--fg-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? hoverBg : 'transparent';
        if (!olive) e.currentTarget.style.color = active ? 'var(--fg-primary)' : baseColor;
      }}
    >
      {name}
    </a>
  );
}

/**
 * Replica of the extension dashboard's left sidebar for app pages:
 * logo on top, Cloud Apps, Local Apps (current app highlighted), Settings.
 * Local Apps come from the dev server (same origin — always available);
 * Cloud Apps and navigation go through the app-shell bridge, degrading
 * gracefully when the page is opened outside the extension.
 */
export function AppSidebar({ appId }: { appId: string }) {
  const [local, setLocal] = useState<LocalManifest[]>([]);
  const [cloud, setCloud] = useState<SourcedManifest[]>([]);
  const [bridgeAlive, setBridgeAlive] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/apps/manifests')
      .then((r) => r.json())
      .then((list) => setLocal(visible(Array.isArray(list) ? list : [])))
      .catch(() => setLocal([]));
    getDashboardManifests()
      .then((all) => {
        setBridgeAlive(true);
        setCloud(visible(all.filter((m) => m._sourceType === 'cloud')));
      })
      .catch(() => setBridgeAlive(false));
  }, []);

  const open = (id: string) => {
    openApp(id).catch(() => {
      window.open(`/api/apps/${id}/ui?app=${id}`, '_blank');
    });
  };

  const sectionBox: React.CSSProperties = {
    background: 'var(--bg-white)',
    border: '1px solid var(--border-tertiary)',
  };

  return (
    <aside
      className="fixed top-0 left-0 h-screen w-[240px] flex flex-col z-30 border-r"
      style={{
        background: 'var(--gray-150)',
        borderColor: 'var(--border-secondary)',
        boxShadow: '2px 0 8px rgba(0,0,0,0.04)',
      }}
    >
      <div className="px-5 pt-5 pb-6 flex justify-center">
        <img src={LOGO_URI} alt="Airglow" width={170} />
      </div>

      <nav
        className="flex-1 overflow-y-auto flex flex-col gap-3"
        style={{ paddingLeft: '12px', paddingRight: '8px' }}
      >
        <div className="rounded-lg p-3" style={sectionBox}>
          <div
            className="px-1 pb-2 text-2xl font-bold border-b"
            style={{ color: 'var(--fg-primary)', borderColor: 'var(--border-tertiary)' }}
          >
            Cloud Apps
          </div>
          {bridgeAlive === false ? (
            <p className="px-1 pt-2 text-sm" style={{ color: 'var(--fg-tertiary)' }}>
              Open the extension dashboard to view cloud apps.
            </p>
          ) : cloud.length === 0 ? (
            <p className="px-1 pt-2 text-sm" style={{ color: 'var(--fg-tertiary)' }}>
              {bridgeAlive === null ? 'Loading…' : 'No cloud apps.'}
            </p>
          ) : (
            cloud.map((app, i) => (
              <AppLink
                key={app.id}
                name={app.name}
                last={i === cloud.length - 1}
                onClick={() => open(app.id)}
                testId={`sidebar-cloud-${app.id}`}
              />
            ))
          )}
        </div>

        <div
          className="rounded-lg p-3"
          style={{
            background: 'color-mix(in srgb, var(--olive) 8%, var(--bg-white))',
            border: '1px solid color-mix(in srgb, var(--olive) 20%, var(--border-tertiary))',
          }}
        >
          <div
            className="px-1 pb-2 text-2xl font-bold border-b"
            style={{
              color: 'var(--olive)',
              borderColor: 'color-mix(in srgb, var(--olive) 20%, var(--border-tertiary))',
            }}
          >
            Local Apps
          </div>
          {local.length === 0 ? (
            <p className="px-1 pt-2 text-sm" style={{ color: 'var(--fg-tertiary)' }}>
              Loading…
            </p>
          ) : (
            local.map((app, i) => (
              <AppLink
                key={app.id}
                name={app.name}
                olive
                active={app.id === appId}
                last={i === local.length - 1}
                onClick={app.id === appId ? undefined : () => open(app.id)}
                testId={`sidebar-local-${app.id}`}
              />
            ))
          )}
        </div>
      </nav>

      <div className="px-3 pb-1 pt-3">
        <div className="rounded-lg p-3" style={sectionBox}>
          <div
            className="flex items-center gap-1.5 px-1 pb-2 text-base font-semibold border-b"
            style={{ color: 'var(--fg-tertiary)', borderColor: 'var(--border-tertiary)' }}
          >
            <Settings size={16} />
            Settings
          </div>
          {bridgeAlive ? (
            <button
              data-testid="sidebar-open-dashboard"
              onClick={() => openDashboard()}
              className="w-full h-9 px-3 mt-2 rounded-md text-base font-medium cursor-pointer transition-all border flex items-center gap-1.5"
              style={{
                color: 'var(--fg-secondary)',
                borderColor: 'var(--border-secondary)',
                background: 'var(--bg-primary)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
            >
              <ExternalLink size={14} />
              Open Dashboard
            </button>
          ) : (
            <p className="px-1 pt-2 text-sm" style={{ color: 'var(--fg-tertiary)' }}>
              Managed in the extension dashboard.
            </p>
          )}
        </div>
      </div>

      <div className="px-5 py-4 text-center">
        <p
          style={{
            color: 'var(--fg-tertiary)',
            fontSize: '12px',
            letterSpacing: '0.02em',
            fontFamily: 'var(--font-sans)',
            lineHeight: '1.6',
          }}
        >
          Airglow — for those who create
        </p>
      </div>
    </aside>
  );
}
