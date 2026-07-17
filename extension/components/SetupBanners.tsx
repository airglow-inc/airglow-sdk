// The ordered setup gate shown at the top of the sidepanel (and dashboard).
// There is a strict preference order — only the single highest-priority unmet
// step renders, never all at once:
//
//   1. Windows unsupported  — handled by the surface (full-screen takeover),
//                             not here; the native host is macOS/Linux only.
//   2. Sign in with Google  — no session → the agent/gateway can't run.
//   3. Install native host  — host disconnected → nothing runs locally.
//   4. Pin to toolbar        — convenience; dismissible (persisted).
//
// Enabling User Scripts is also required, but it's a hard gate rather than a
// dismissible nag, so it lives in its own blocking overlay
// (components/UserScriptsOverlay.tsx) — not in this ordered list.
//
// State is polled (chrome.action exposes no change event), so a banner clears
// on its own once satisfied — no sidepanel reload needed. Pass `force`
// (planmock) to render every banner for design.

import { useEffect, useState, type ReactElement } from 'react';
import { Check, Copy, LogIn, Pin } from 'lucide-react';
import { AUTH_SESSION_KEY, AuthCancelledError, getStoredSession, isAuthConfigured, signInWithGoogle, type AuthSession } from '../lib/airglow-auth';

const INSTALL_CMD = 'curl -fsSL https://airglow.dev/install.sh | bash';

// Pin is a convenience, not a blocker — once dismissed it stays dismissed
// across sessions (it still auto-hides the moment the icon is pinned).

export type SetupStep = 'signin' | 'host' | 'pin';
const ALL_STEPS: SetupStep[] = ['signin', 'host', 'pin'];

export function GoogleLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function PuzzleIcon({ size = 16, color = 'currentColor', className = '' }: { size?: number; color?: string; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 -960 960 960" fill={color} className={className} aria-hidden="true">
      <path d="M352-120H200q-33 0-56.5-23.5T120-200v-152q48 0 84-30.5t36-77.5q0-47-36-77.5T120-568v-152q0-33 23.5-56.5T200-800h160q0-42 29-71t71-29q42 0 71 29t29 71h160q33 0 56.5 23.5T800-720v160q42 0 71 29t29 71q0 42-29 71t-71 29v160q0 33-23.5 56.5T720-120H568q0-50-31.5-85T460-240q-45 0-76.5 35T352-120Zm-152-80h85q24-66 77-93t98-27q45 0 98 27t77 93h85v-240h80q8 0 14-6t6-14q0-8-6-14t-14-6h-80v-240H480v-80q0-8-6-14t-14-6q-8 0-14 6t-6 14v80H200v88q54 20 87 67t33 105q0 57-33 104t-87 68v88Zm260-260Z" />
    </svg>
  );
}

export function Step({ n }: { n: number }) {
  return (
    <span
      className="shrink-0 text-[12px] font-medium w-5 h-5 inline-flex items-center justify-center rounded-full"
      style={{ background: 'color-mix(in srgb, var(--error) 22%, var(--bg-white))', color: 'var(--error)' }}
    >
      {n}
    </span>
  );
}

const cardStyle = {
  background: 'color-mix(in srgb, var(--error) 7%, var(--bg-white))',
  borderColor: 'color-mix(in srgb, var(--error) 30%, var(--border-tertiary))',
} as const;

// Live setup state, polled every 2s (chrome.action emits no change event, so a
// freshly pinned icon would otherwise stay invisible until the panel is
// reopened). Host + auth also react instantly to storage changes.
function useSetupState() {
  const [s, setS] = useState<{
    loaded: boolean;
    authSession: AuthSession | null;
    hostConnected: boolean | null;
    isPinned: boolean | null;
  }>({ loaded: false, authSession: null, hostConnected: null, isPinned: null });

  useEffect(() => {
    let alive = true;
    async function probe() {
      let isPinned: boolean | null = null;
      try { const us = await chrome.action?.getUserSettings?.(); if (us) isPinned = !!us.isOnToolbar; } catch { /* not available */ }
      const stored = await chrome.storage.local.get('__native_host_connected');
      const nh = stored['__native_host_connected'];
      const hostConnected = nh === undefined ? null : !!nh;
      const authSession = await getStoredSession();
      if (alive) setS({ loaded: true, authSession, hostConnected, isPinned });
    }
    void probe();
    const id = setInterval(() => { void probe(); }, 2000);
    const onChange = (c: Record<string, chrome.storage.StorageChange>) => {
      if ('__native_host_connected' in c || AUTH_SESSION_KEY in c) void probe();
    };
    chrome.storage?.local?.onChanged.addListener(onChange);
    return () => { alive = false; clearInterval(id); chrome.storage?.local?.onChanged.removeListener(onChange); };
  }, []);

  return s;
}

export function SetupBanners({
  variant = 'sidepanel',
  steps = ALL_STEPS,
  force = false,
  onActiveChange,
}: { variant?: 'sidepanel' | 'dashboard'; steps?: SetupStep[]; force?: boolean; onActiveChange?: (step: SetupStep | null) => void } = {}) {
  const state = useSetupState();
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [installCopied, setInstallCopied] = useState(false);

  async function doSignIn() {
    if (signingIn) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      await signInWithGoogle({ interactive: true });
      // Session lands in storage → the poll/onChanged clears this banner.
    } catch (e) {
      if (e instanceof AuthCancelledError) return; // user closed the picker — not an error
      setSignInError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningIn(false);
    }
  }

  function copyInstall() {
    navigator.clipboard.writeText(INSTALL_CMD).then(() => {
      setInstallCopied(true);
      setTimeout(() => setInstallCopied(false), 1500);
    });
  }

  const wrap = variant === 'dashboard'
    ? 'relative p-3.5 rounded-xl border w-[520px] max-w-full'
    : 'relative m-3 p-3.5 rounded-xl border';

  const renderers: Record<SetupStep, () => ReactElement> = {
    signin: () => (
      <div className={wrap} style={cardStyle} data-testid="banner-signin">
        <div className="text-[15px] font-semibold flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
          <LogIn size={18} style={{ color: 'var(--error)' }} />
          Sign in to Airglow
        </div>
        <button
          onClick={doSignIn}
          disabled={signingIn}
          data-testid="google-signin-button"
          className="mt-3 h-10 px-4 rounded-md text-[14px] font-medium cursor-pointer border inline-flex items-center gap-2.5"
          style={{ color: 'var(--fg-primary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-white)', opacity: signingIn ? 0.6 : 1 }}
          onMouseEnter={(e) => { if (!signingIn) e.currentTarget.style.background = 'var(--bg-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; }}
        >
          <GoogleLogo size={16} />
          {signingIn ? 'Signing in…' : 'Sign in with Google'}
        </button>
        {signInError && (
          <div className="mt-2 text-[13px]" style={{ color: 'var(--error)' }} data-testid="google-signin-error">{signInError}</div>
        )}
      </div>
    ),

    host: () => (
      <div className={wrap} style={cardStyle} data-testid="banner-host">
        <div className="text-[15px] font-semibold mb-1" style={{ color: 'var(--fg-primary)' }}>Airglow host is not connected</div>
        <div className="text-[14px]" style={{ color: 'var(--fg-primary)' }}>
          Host is a binary that allows you to run Airglow apps locally. Install it using the command below.
        </div>
        <div className="mt-3 mb-1.5 text-[14px] font-semibold" style={{ color: 'var(--fg-primary)' }}>Paste in terminal</div>
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={copyInstall}
            title={installCopied ? 'Copied' : 'Copy'}
            className="shrink-0 flex items-center justify-center w-8 rounded-sm cursor-pointer"
            style={{ background: 'var(--gray-150)', border: '1px solid var(--border-tertiary)', color: 'var(--fg-secondary)' }}
          >
            {installCopied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <pre className="flex-1 min-w-0 p-2 rounded-sm text-[12px] overflow-x-auto" style={{ background: 'var(--gray-150)', border: '1px solid var(--border-tertiary)', fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>
            {INSTALL_CMD}
          </pre>
        </div>
        <div className="mt-2.5 text-[14px]" style={{ color: 'var(--fg-secondary)' }}>
          <div className="mb-1 font-semibold" style={{ color: 'var(--fg-primary)' }}>What the script does:</div>
          <ul className="space-y-1 list-disc pl-4">
            <li>Downloads the host binary to <code style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.92em', padding: '1px 5px', borderRadius: '5px', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)' }}>~/.airglow</code> (no admin rights, no system changes)</li>
            <li>Sets up your <code style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.92em', padding: '1px 5px', borderRadius: '5px', background: 'var(--bg-tertiary)', color: 'var(--fg-primary)' }}>~/.airglow</code> workspace — folder to develop Airglow apps</li>
          </ul>
        </div>
      </div>
    ),

    pin: () => (
      <div className={wrap} style={cardStyle} data-testid="banner-pin">
        <div className="text-[19px] font-semibold flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
          <Pin size={22} style={{ color: 'var(--error)' }} />
          Add Airglow shortcut
        </div>
        <div className="flex flex-col gap-2 mt-3 text-[16px]" style={{ color: 'var(--fg-secondary)' }}>
          <div className="flex items-start gap-2">
            <Step n={1} />
            <span className="inline-flex items-center gap-1 flex-wrap">
              Click <PuzzleIcon size={22} className="inline-block shrink-0" color="var(--fg-primary)" /> icon <strong>(Extensions)</strong> in top right corner
            </span>
          </div>
          <div className="flex items-start gap-2">
            <Step n={2} />
            <span className="inline-flex items-center gap-1 flex-wrap">
              Click <Pin size={22} className="inline-block shrink-0" style={{ color: 'var(--fg-primary)' }} /> icon next to <strong>Airglow</strong>
            </span>
          </div>
        </div>
        <img
          src={chrome.runtime.getURL('pin-instructions.png')}
          alt="Chrome Extensions menu: the puzzle icon in the top right corner and the pin button next to Airglow"
          className="mt-3 block mx-auto w-[380px] max-w-full rounded-sm border"
          style={{ borderColor: 'color-mix(in srgb, var(--error) 22%, var(--border-tertiary))' }}
        />
      </div>
    ),
  };

  // Strict preference order: the first unmet step wins, the rest stay hidden.
  // Computed before any early return so the active step can be reported to the
  // parent (which hides the panel's working surface while a banner is up).
  let active: SetupStep | null = null;
  if (state.loaded) {
    for (const step of steps) {
      if (step === 'signin' && !state.authSession && isAuthConfigured()) { active = step; break; }
      if (step === 'host' && state.hostConnected === false) { active = step; break; }
      if (step === 'pin' && state.isPinned === false) { active = step; break; }
    }
  }
  // In force/preview mode every banner renders at once — report no single active.
  const reported = force ? null : active;
  useEffect(() => { onActiveChange?.(reported); }, [reported, onActiveChange]);

  // Design preview (planmock): render every owned banner.
  if (force) {
    return <>{steps.map((step) => <div key={step}>{renderers[step]()}</div>)}</>;
  }
  if (!state.loaded || !active) return null;
  return renderers[active]();
}
