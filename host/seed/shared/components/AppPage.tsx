import React, { useEffect, useState } from 'react';
import { KeyRound, Server, Eye, EyeOff } from 'lucide-react';

// True when this page renders embedded in the dashboard iframe (vs. a standalone
// tab). Settings + app controls only work through the dashboard bridge.
const isEmbedded = () => typeof window !== 'undefined' && window.parent !== window;

// The SDK global injected into every app context. Typed loosely here so the
// shared component compiles regardless of whether airglow.d.ts is in scope.
const ag = (): any => (globalThis as any).airglow;

type SecretDecl = { label?: string; description?: string } | true;
type SecretsManifest = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  secrets?: Record<string, SecretDecl>;
  server_env?: Record<string, SecretDecl>;
  userscripts?: { file?: string; matches?: string[] }[];
};

// The page is always served from the same origin as the manifests endpoint
// (the local daemon), so a relative fetch works both in the dashboard iframe
// and in a standalone tab.
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
 * Standard layout for an app's page — the settings + overview surface every
 * app gets. A fixed header card (title, description, status, Enable/Disable,
 * Uninstall) stays pinned while the content below scrolls. `name`/`description`
 * fall back to the manifest, so a page can be rendered from just the appId
 * (the daemon serves this layout by default for apps that ship no `ui/`).
 */
export function AppPage({
  appId,
  name,
  description,
  preview,
  children,
}: {
  appId: string;
  name?: string;
  description?: string;
  preview?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const manifest = useAppManifest(appId);
  const clientSecrets = secretList(manifest?.secrets);
  const serverSecrets = secretList(manifest?.server_env);
  const hasRail = !!preview || clientSecrets.length + serverSecrets.length > 0;
  const hasOwnContent = !!children;
  // The app's UI is the *content area only*. The single shell (the dashboard)
  // owns the sidebar + header (title, breadcrumb, Enable/Disable, Uninstall) and
  // hosts this in a sandboxed iframe. `name`/`description` are still accepted for
  // back-compat but rendered by the shell, not here.
  void name; void description;
  return (
    <div className="p-8" style={{ background: 'var(--bg-primary)', minHeight: '100%' }}>
      <div className="max-w-6xl mx-auto">
        {/* Settings flow in the wide left column; the preview + secrets sit in a
            sticky right rail so the page uses the full width. The two-column layout
            holds down to `md` (768px) so it survives the side panel narrowing the
            dashboard; below that it collapses to a single column (rail first). */}
        <div className={hasRail ? 'grid grid-cols-1 md:grid-cols-3 gap-x-8 items-start' : ''}>
          {hasRail && (
            <aside className="md:col-span-1 md:order-2 md:sticky md:top-0 mb-6 md:mb-0">
              {preview && (
                <SettingsSection title="What it looks like">
                  {preview}
                </SettingsSection>
              )}
              <div className="flex flex-col gap-4">
                <SecretGroup appId={appId} scope="client" secrets={clientSecrets} />
                <SecretGroup appId={appId} scope="server" secrets={serverSecrets} />
              </div>
            </aside>
          )}

          <div className={hasRail ? 'md:col-span-2 md:order-1 min-w-0' : ''}>
            {hasOwnContent ? children : <OverviewPlaceholder />}
          </div>
        </div>
      </div>
    </div>
  );
}

// Shown on the default page (apps with no settings of their own) so the page
// still reads as an overview rather than looking broken.
function OverviewPlaceholder() {
  return (
    <SettingsSection title="Settings">
      <p className="text-sm" style={{ color: 'var(--fg-tertiary)' }}>
        This app has no settings to configure. Use the header above to enable,
        disable, or uninstall it.
      </p>
    </SettingsSection>
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

// ── Secrets ────────────────────────────────────────────────────────────────
// Secrets are managed per app, in place on the app page — no global Secrets
// screen. Server keys (manifest.server_env) are stored daemon-side via
// /api/env/set (works from any tab, same origin); client keys (manifest.secrets)
// live in this app's airglow.storage (dashboard bridge, embedded only).

const SECRET_SCOPES = {
  client: {
    title: 'Client keys',
    hint: "stored in this app's storage",
    Icon: KeyRound,
  },
  server: {
    title: 'Server keys',
    hint: 'stored locally on your machine',
    Icon: Server,
  },
} as const;

type KeyState = { set: boolean; maskedTail?: string };

// Set-state per key. Server keys come from the daemon; client keys from
// airglow.storage. Returns the state map plus a reloader.
function useSecretState(
  appId: string,
  scope: 'client' | 'server',
  names: string[],
): [Record<string, KeyState>, () => void] {
  const [state, setState] = useState<Record<string, KeyState>>({});
  const key = names.join(',');
  const reload = React.useCallback(() => {
    if (scope === 'server') {
      fetch('/api/env/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const app = d?.apps?.find((a: any) => a.appId === appId);
          const map: Record<string, KeyState> = {};
          for (const k of app?.keys ?? []) map[k.key] = { set: !!k.set, maskedTail: k.maskedTail };
          setState(map);
        })
        .catch(() => {});
    } else {
      Promise.all(
        names.map((n) =>
          Promise.resolve(ag()?.storage?.get?.(n))
            .then((v: any) => [n, { set: v != null && v !== '' }] as const)
            .catch(() => [n, { set: false }] as const),
        ),
      ).then((pairs) => setState(Object.fromEntries(pairs)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, scope, key]);
  useEffect(reload, [reload]);
  return [state, reload];
}

function SecretGroup({
  appId,
  scope,
  secrets,
}: {
  appId: string;
  scope: 'client' | 'server';
  secrets: { name: string; note?: string }[];
}) {
  const { title, hint, Icon } = SECRET_SCOPES[scope];
  const names = secrets.map((s) => s.name);
  const [state, reload] = useSecretState(appId, scope, names);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Client keys need the dashboard bridge; server keys post to the daemon.
  const canEdit = scope === 'server' || isEmbedded();
  const dirty = Object.values(inputs).some((v) => v.trim() !== '');

  if (secrets.length === 0) return null;

  // Eye toggle. Revealing a set key with nothing typed pulls the stored value
  // into the field so it's viewable (server: daemon reveal; client: storage).
  const reveal = async (name: string) => {
    const turningOn = !show[name];
    setShow((p) => ({ ...p, [name]: turningOn }));
    if (!turningOn || inputs[name] || !state[name]?.set) return;
    let v = '';
    if (scope === 'server') {
      v = await fetch(`/api/env/reveal?appId=${encodeURIComponent(appId)}&key=${encodeURIComponent(name)}`)
        .then((r) => (r.ok ? r.json() : null)).then((d) => d?.value ?? '').catch(() => '');
    } else {
      v = (await Promise.resolve(ag()?.storage?.get?.(name)).catch(() => '')) ?? '';
    }
    if (v) setInputs((p) => ({ ...p, [name]: v }));
  };

  const save = async () => {
    if (!canEdit || saving || !dirty) return;
    setSaving(true);
    try {
      const entries = Object.fromEntries(Object.entries(inputs).filter(([, v]) => v.trim() !== ''));
      if (scope === 'server') {
        await fetch('/api/env/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId, entries }),
        });
      } else {
        await Promise.all(Object.entries(entries).map(([k, v]) => ag()?.storage?.set?.(k, v)));
      }
      setInputs({});
      setShow({});
      reload();
      setSaved(true);
    } catch (e: any) {
      alert(`Couldn't save secrets: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid={`secret-group-${scope}`}>
      <div className="mb-2 text-sm flex items-center gap-1.5" style={{ color: 'var(--fg-tertiary)' }}>
        <Icon size={14} />
        <span className="font-semibold" style={{ color: 'var(--fg-secondary)' }}>{title}</span>
        <span>· {hint}</span>
      </div>
      <div className="flex flex-col gap-2.5">
        {secrets.map((s) => (
          <SecretField
            key={s.name}
            name={s.name}
            note={s.note}
            status={state[s.name]}
            value={inputs[s.name] ?? ''}
            show={!!show[s.name]}
            disabled={!canEdit}
            onChange={(v) => { setSaved(false); setInputs((p) => ({ ...p, [s.name]: v })); }}
            onToggleShow={() => reveal(s.name)}
          />
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!canEdit || !dirty || saving}
          className="h-8 px-3 rounded-md text-sm font-semibold cursor-pointer border"
          style={{
            color: 'var(--bg-white)', background: 'var(--clay)', borderColor: 'var(--clay)',
            opacity: !canEdit || !dirty || saving ? 0.5 : 1,
          }}
          data-testid={`secret-save-${scope}`}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && <span className="text-xs font-medium" style={{ color: 'var(--olive)' }}>Saved</span>}
        {!canEdit && <span className="text-xs" style={{ color: 'var(--fg-tertiary)' }}>Open from the extension to edit</span>}
      </div>
    </div>
  );
}

// One editable secret row: key name, set/not-set status, masked input + reveal.
function SecretField({
  name, note, status, value, show, disabled, onChange, onToggleShow,
}: {
  name: string;
  note?: string;
  status?: KeyState;
  value: string;
  show: boolean;
  disabled?: boolean;
  onChange: (v: string) => void;
  onToggleShow: () => void;
}) {
  const isSet = !!status?.set;
  return (
    <div
      className="px-3 py-2.5 rounded-lg border"
      style={{
        background: 'var(--bg-white)',
        borderColor: isSet
          ? 'color-mix(in srgb, var(--olive) 35%, var(--border-tertiary))'
          : 'color-mix(in srgb, var(--clay) 35%, var(--border-tertiary))',
      }}
      data-testid={`secret-${name}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <code className="text-xs font-semibold break-all" style={{ color: 'var(--fg-primary)' }}>{name}</code>
        <span
          className="text-[11px] font-medium px-1.5 py-0.5 rounded shrink-0"
          style={{
            color: isSet ? 'var(--olive)' : 'var(--clay-interactive)',
            background: isSet
              ? 'color-mix(in srgb, var(--olive) 12%, transparent)'
              : 'color-mix(in srgb, var(--clay) 12%, transparent)',
          }}
        >
          {isSet ? (status?.maskedTail ? `set · ${status.maskedTail}` : 'set') : 'not set'}
        </span>
      </div>
      {note && <p className="text-xs mb-1.5" style={{ color: 'var(--fg-tertiary)' }}>{note}</p>}
      <div className="flex items-center gap-1.5">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          disabled={disabled}
          placeholder={isSet ? 'Enter new value to replace' : 'Enter value'}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 min-w-0 h-8 px-2.5 rounded-md text-sm border"
          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-secondary)', color: 'var(--fg-primary)' }}
          data-testid={`secret-input-${name}`}
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="h-8 w-8 flex items-center justify-center rounded-md border cursor-pointer shrink-0"
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-secondary)', color: 'var(--fg-tertiary)' }}
          aria-label={show ? 'Hide value' : 'Show value'}
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
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
