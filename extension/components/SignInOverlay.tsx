// Blocking Google sign-in gate for the sidepanel. Unlike the inline
// SetupBanners row, this covers the whole panel (above the header, drawers and
// composer) so the agent can't be messaged until there's a session — the
// gateway hard-requires the server-issued JWT, so an unsigned turn only 401s.
//
// On mount it makes a single SILENT sign-in attempt (interactive: false): if
// the Chrome profile already granted consent, the session lands without a click
// and the overlay never paints. Otherwise it shows the one-click CTA. Auth state
// is read from storage and kept live via the AUTH_SESSION_KEY change event plus
// a slow poll (the background's boot sign-in writes it asynchronously).

import { useEffect, useRef, useState } from 'react';
import { LogIn } from 'lucide-react';
import { AUTH_SESSION_KEY, AuthCancelledError, getStoredSession, isAuthConfigured, signInWithGoogle, type AuthSession } from '../lib/airglow-auth';
import { GoogleLogo } from './SetupBanners';

// Reads the stored session and keeps it live; makes one silent sign-in attempt
// when nothing is stored. `loaded` gates the first paint so the overlay never
// flashes before storage is read.
export function useAuthSession(): { loaded: boolean; session: AuthSession | null } {
  const [state, setState] = useState<{ loaded: boolean; session: AuthSession | null }>({ loaded: false, session: null });
  const silentTried = useRef(false);

  useEffect(() => {
    let alive = true;
    async function refresh(): Promise<void> {
      const session = await getStoredSession();
      if (!alive) return;
      setState({ loaded: true, session });
      if (!session && isAuthConfigured() && !silentTried.current) {
        silentTried.current = true;
        try {
          const s = await signInWithGoogle({ interactive: false });
          if (alive) setState({ loaded: true, session: s });
        } catch {
          // No prior consent → needs the interactive button below.
        }
      }
    }
    void refresh();
    const onChange = (c: Record<string, chrome.storage.StorageChange>) => {
      if (AUTH_SESSION_KEY in c) void refresh();
    };
    chrome.storage?.local?.onChanged.addListener(onChange);
    const poll = setInterval(() => { void refresh(); }, 2000);
    return () => { alive = false; chrome.storage?.local?.onChanged.removeListener(onChange); clearInterval(poll); };
  }, []);

  return state;
}

export function SignInOverlay() {
  const { loaded, session } = useAuthSession();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doSignIn(): Promise<void> {
    if (signingIn) return;
    setSigningIn(true);
    setError(null);
    try {
      await signInWithGoogle({ interactive: true });
      // Session lands in storage → useAuthSession clears the overlay.
    } catch (e) {
      if (e instanceof AuthCancelledError) return; // user closed the picker — not an error
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningIn(false);
    }
  }

  // Don't gate: forks that ship no OAuth client, dev's auto-seeded session, or
  // the pre-load flash. Once a session exists the overlay unmounts.
  if (!loaded || session || !isAuthConfigured()) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center p-5"
      style={{ background: 'color-mix(in srgb, var(--bg-primary) 82%, transparent)', backdropFilter: 'blur(3px)' }}
      data-testid="signin-overlay"
    >
      <div
        className="w-full max-w-[340px] rounded-2xl border p-6 text-center"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-tertiary)', boxShadow: '0 12px 40px rgba(17, 17, 16, 0.18)' }}
      >
        <div
          className="mx-auto mb-4 inline-flex items-center justify-center w-12 h-12 rounded-xl"
          style={{ background: 'color-mix(in srgb, var(--clay) 14%, transparent)', color: 'var(--clay-interactive)' }}
        >
          <LogIn size={22} />
        </div>
        <div className="text-[18px] font-semibold" style={{ color: 'var(--fg-primary)' }}>
          Sign in to Airglow
        </div>
        <button
          onClick={doSignIn}
          disabled={signingIn}
          data-testid="google-signin-button"
          className="mt-5 w-full h-11 rounded-lg text-[14px] font-medium cursor-pointer border inline-flex items-center justify-center gap-2.5"
          style={{ color: 'var(--fg-primary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-white)', opacity: signingIn ? 0.6 : 1 }}
          onMouseEnter={(e) => { if (!signingIn) e.currentTarget.style.background = 'var(--bg-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; }}
        >
          <GoogleLogo size={17} />
          {signingIn ? 'Signing in…' : 'Sign in with Google'}
        </button>
        {error && (
          <div className="mt-3 text-[13px]" style={{ color: 'var(--error)' }} data-testid="google-signin-error">{error}</div>
        )}
      </div>
    </div>
  );
}
