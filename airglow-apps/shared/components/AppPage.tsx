import React, { useEffect, useState } from 'react';
import { KeyRound, Server } from 'lucide-react';
import { AppSidebar } from './AppSidebar';
import { isEmbedded } from '../lib/appShellBridge';

type SecretDecl = { label?: string; description?: string } | true;
type SecretsManifest = {
  id?: string;
  secrets?: Record<string, SecretDecl>;
  server_env?: Record<string, SecretDecl>;
};

// The page is always served from the same origin as the manifests endpoint
// (local dev server or the cloud app source), so a relative fetch works both
// in the app-shell iframe and in a standalone tab.
let manifestsPromise: Promise<SecretsManifest[]> | null = null;
function fetchManifests(): Promise<SecretsManifest[]> {
  if (!manifestsPromise) {
    manifestsPromise = fetch('/api/apps/manifests')
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return manifestsPromise;
}

function useAppManifest(appId: string): SecretsManifest | null {
  const [manifest, setManifest] = useState<SecretsManifest | null>(null);
  useEffect(() => {
    let live = true;
    fetchManifests().then((all) => {
      if (live) setManifest(all.find((m) => m.id === appId) ?? null);
    });
    return () => { live = false; };
  }, [appId]);
  return manifest;
}

function secretList(decls?: Record<string, SecretDecl>): { name: string; note?: string }[] {
  return Object.entries(decls ?? {}).map(([name, d]) => ({
    name,
    note: typeof d === 'object' ? d.description : undefined,
  }));
}

/**
 * Standard layout for an app's page (what users see when they click the app
 * in the extension dashboard). Renders the dashboard-style sidebar plus a
 * content column with the app name, a description of what the app does, an
 * optional preview of UI the app injects into websites, read-only secret
 * callouts (derived from the app's manifest — `secrets` for client keys,
 * `server_env` for server keys), and the app's own settings/content as
 * children.
 */
export function AppPage({
  appId,
  name,
  description,
  preview,
  children,
}: {
  appId: string;
  name: string;
  description: string;
  preview?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const manifest = useAppManifest(appId);
  const clientSecrets = secretList(manifest?.secrets);
  const serverSecrets = secretList(manifest?.server_env);
  const hasRail = !!preview || clientSecrets.length + serverSecrets.length > 0;
  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AppSidebar appId={appId} />
      <main className="ml-[240px] flex-1 p-8 min-w-0">
        <div className="max-w-6xl mx-auto">
          {!isEmbedded() && (
            <div
              className="mb-5 px-4 py-2.5 rounded-lg text-sm font-medium"
              style={{
                background: 'color-mix(in srgb, var(--clay) 12%, var(--bg-white))',
                border: '1px solid color-mix(in srgb, var(--clay) 30%, var(--border-tertiary))',
                color: 'var(--fg-secondary)',
              }}
              data-testid="standalone-banner"
            >
              Open this page from the Airglow extension for full functionality —
              settings can't be saved from a standalone tab.
            </div>
          )}

          <h1
            className="text-3xl font-bold tracking-tight"
            style={{ color: 'var(--fg-primary)' }}
            data-testid="app-page-title"
          >
            {name}
          </h1>
          <p className="mt-2 mb-6 text-base max-w-2xl" style={{ color: 'var(--fg-secondary)' }}>
            {description}
          </p>

          {/* Settings flow in the wide left column; the preview + secrets sit in
              a sticky right rail so the page uses the full width. On narrow
              widths it collapses to a single column (rail first). */}
          <div className={hasRail ? 'grid grid-cols-1 lg:grid-cols-3 gap-x-8 items-start' : ''}>
            {hasRail && (
              <aside className="lg:col-span-1 lg:order-2 lg:sticky lg:top-8 mb-6 lg:mb-0">
                {preview && (
                  <SettingsSection title="What it looks like">
                    {preview}
                  </SettingsSection>
                )}
                <div className="flex flex-col gap-4">
                  <SecretGroup scope="client" secrets={clientSecrets} />
                  <SecretGroup scope="server" secrets={serverSecrets} />
                </div>
              </aside>
            )}

            <div className={hasRail ? 'lg:col-span-2 lg:order-1 min-w-0' : ''}>
              {children}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-lg p-5 mb-6 border"
      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-tertiary)' }}
    >
      <h2
        className="text-lg font-semibold mb-4"
        style={{ color: 'var(--fg-primary)' }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export function SettingField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <label className="block text-sm font-semibold mb-1" style={{ color: 'var(--fg-secondary)' }}>
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-xs" style={{ color: 'var(--fg-tertiary)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

const SECRET_SCOPES = {
  client: {
    title: 'Client keys',
    hint: "set in the extension's Secrets page",
    Icon: KeyRound,
  },
  server: {
    title: 'Server keys',
    hint: 'set in the local .env file',
    Icon: Server,
  },
} as const;

function SecretGroup({
  scope,
  secrets,
}: {
  scope: 'client' | 'server';
  secrets: { name: string; note?: string }[];
}) {
  if (secrets.length === 0) return null;
  const { title, hint, Icon } = SECRET_SCOPES[scope];
  return (
    <div data-testid={`secret-group-${scope}`}>
      <div className="mb-2 text-sm" style={{ color: 'var(--fg-tertiary)' }}>
        <span className="font-semibold" style={{ color: 'var(--fg-secondary)' }}>{title}</span>
        {' — '}
        {hint}
      </div>
      <div className="flex flex-col gap-2">
        {secrets.map((s) => (
          <SecretCallout key={s.name} name={s.name} note={s.note} Icon={Icon} />
        ))}
      </div>
    </div>
  );
}

export function SecretCallout({
  name,
  note,
  Icon = KeyRound,
}: {
  name: string;
  note?: string;
  Icon?: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
}) {
  return (
    <div
      className="flex items-start gap-2.5 px-4 py-3 rounded-lg border"
      style={{
        background: 'color-mix(in srgb, var(--sky) 8%, var(--bg-white))',
        borderColor: 'color-mix(in srgb, var(--sky) 25%, var(--border-tertiary))',
      }}
      data-testid={`secret-${name}`}
    >
      <Icon size={16} style={{ color: 'var(--sky)', marginTop: 2, flex: 'none' }} />
      <div className="text-sm" style={{ color: 'var(--fg-secondary)' }}>
        <code className="font-semibold" style={{ color: 'var(--fg-primary)' }}>{name}</code>
        {note ? <> — {note}</> : null}
      </div>
    </div>
  );
}
