import React from 'react';
import { KeyRound } from 'lucide-react';
import { AppSidebar } from './AppSidebar';
import { isEmbedded } from '../lib/appShellBridge';

/**
 * Standard layout for an app's page (what users see when they click the app
 * in the extension dashboard). Renders the dashboard-style sidebar plus a
 * content column with the app name, a description of what the app does, an
 * optional preview of UI the app injects into websites, read-only secret
 * callouts, and the app's own settings/content as children.
 */
export function AppPage({
  appId,
  name,
  description,
  preview,
  secrets,
  children,
}: {
  appId: string;
  name: string;
  description: string;
  preview?: React.ReactNode;
  secrets?: { name: string; note?: string }[];
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AppSidebar appId={appId} />
      <main className="ml-[240px] flex-1 p-8 min-w-0">
        <div className="max-w-3xl">
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
          <p className="mt-2 mb-6 text-base" style={{ color: 'var(--fg-secondary)' }}>
            {description}
          </p>

          {preview && (
            <SettingsSection title="What it looks like">
              {preview}
            </SettingsSection>
          )}

          {secrets && secrets.length > 0 && (
            <div className="mb-6 flex flex-col gap-2">
              {secrets.map((s) => (
                <SecretCallout key={s.name} name={s.name} note={s.note} />
              ))}
            </div>
          )}

          {children}
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

export function SecretCallout({ name, note }: { name: string; note?: string }) {
  return (
    <div
      className="flex items-start gap-2.5 px-4 py-3 rounded-lg border"
      style={{
        background: 'color-mix(in srgb, var(--sky) 8%, var(--bg-white))',
        borderColor: 'color-mix(in srgb, var(--sky) 25%, var(--border-tertiary))',
      }}
      data-testid={`secret-${name}`}
    >
      <KeyRound size={16} style={{ color: 'var(--sky)', marginTop: 2, flex: 'none' }} />
      <div className="text-sm" style={{ color: 'var(--fg-secondary)' }}>
        <code className="font-semibold" style={{ color: 'var(--fg-primary)' }}>{name}</code>
        {' — '}
        {note ?? "required secret; set it in the extension's Secrets page."}
      </div>
    </div>
  );
}
