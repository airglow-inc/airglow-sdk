// Shown in the sidepanel when the extension is running on Windows. The native
// host (daemon + connector) is macOS/Linux only (see host/src/install.ts), so
// on Windows every host-backed feature — apps, agent, browser control,
// secrets, connectors — is dead. The Chrome Web Store has no per-OS gate, so a
// Windows user can install the extension; this banner is the honest "it won't
// work here" state, shown instead of an eternal "Disconnected" spinner.
//
// It also captures a "notify me when Windows ships" email (the only conversion
// we can salvage from a Windows install). This is pre-sign-in — Google sign-in
// needs the native host, which doesn't run here — so the email is typed by the
// user, optionally prefilled from the Chrome profile's Google account
// (chrome.identity.getProfileUserInfo, no consent prompt). It's POSTed to the
// cloud waitlist (/api/windows-waitlist).

import { type FormEvent, useEffect, useState } from 'react';
import { MonitorX } from 'lucide-react';
import { getCloudApiUrl } from '../lib/cloud-api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBMIT_TIMEOUT_MS = 10_000;

// Best-effort read of the profile's primary Google account email. Returns '' if
// the user isn't signed into Chrome (installing ≠ being signed in), in
// incognito, or if the API is unavailable. Never throws.
async function readProfileEmail(): Promise<string> {
  try {
    if (!chrome?.identity?.getProfileUserInfo) return '';
    const info = await new Promise<chrome.identity.ProfileUserInfo | null>((resolve) => {
      try {
        chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' } as chrome.identity.ProfileDetails, (i) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(i);
        });
      } catch {
        resolve(null);
      }
    });
    return info?.email?.trim() || '';
  } catch {
    return '';
  }
}

async function submitWaitlist(email: string, prefilled: boolean): Promise<void> {
  const baseUrl = await getCloudApiUrl();
  const res = await fetch(`${baseUrl}/api/windows-waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      os: 'win',
      extVersion: chrome.runtime.getManifest().version,
      prefilled,
    }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = `Request failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.error === 'string') detail = body.error;
    } catch {}
    throw new Error(detail);
  }
}

export function WindowsUnsupportedBanner() {
  const [email, setEmail] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  // Prefill from the Chrome profile's Google account when available (no prompt).
  useEffect(() => {
    let alive = true;
    readProfileEmail().then((found) => {
      if (alive && found) {
        setEmail((current) => (current ? current : found));
        setPrefilled(true);
      }
    });
    return () => { alive = false; };
  }, []);

  const valid = EMAIL_RE.test(email.trim());

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'submitting' || !valid) return;
    setStatus('submitting');
    setError('');
    try {
      // `prefilled` reflects the autofilled value only if the user kept it.
      await submitWaitlist(email.trim(), prefilled && email.trim() !== '');
      setStatus('done');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Could not save your email.');
    }
  }

  const submitting = status === 'submitting';

  return (
    <div
      data-testid="banner-windows-unsupported"
      className="w-full max-w-[340px] rounded-[var(--radius-md)] border p-6 text-center"
      style={{
        background: 'color-mix(in srgb, var(--error) 7%, var(--bg-white))',
        borderColor: 'color-mix(in srgb, var(--error) 28%, var(--border-tertiary))',
      }}
    >
      <div
        className="mx-auto mb-4 inline-flex items-center justify-center rounded-full"
        style={{
          width: 56,
          height: 56,
          background: 'color-mix(in srgb, var(--error) 12%, var(--bg-white))',
          color: 'var(--error)',
        }}
      >
        <MonitorX size={30} strokeWidth={1.75} />
      </div>
      <div className="text-[19px] font-semibold leading-snug" style={{ color: 'var(--fg-primary)' }}>
        Windows isn’t supported
      </div>
      <div className="mt-2 text-[14px] leading-relaxed" style={{ color: 'var(--fg-secondary)' }}>
        For now, Airglow only supports macOS and Linux.
      </div>

      <div className="mt-5 pt-5 border-t" style={{ borderColor: 'color-mix(in srgb, var(--error) 18%, var(--border-tertiary))' }}>
        {status === 'done' ? (
          <div className="text-[13.5px] leading-relaxed" data-testid="waitlist-done" style={{ color: 'var(--olive)' }}>
            Thanks — we’ll email <span className="font-medium">{email.trim()}</span> when Windows support lands.
          </div>
        ) : (
          <form onSubmit={onSubmit} data-testid="waitlist-form">
            <div className="text-[13px] mb-2.5 leading-snug" style={{ color: 'var(--fg-secondary)' }}>
              Want to know when it’s ready? Leave your email and we’ll notify you.
            </div>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (status === 'error') setStatus('idle'); }}
              placeholder="you@example.com"
              disabled={submitting}
              className="w-full h-9 px-3 text-[14px] rounded-md border outline-none"
              style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)', color: 'var(--fg-primary)' }}
              data-testid="waitlist-email"
              autoComplete="email"
            />
            <button
              type="submit"
              disabled={submitting || !valid}
              className="mt-2.5 w-full h-9 px-4 rounded-md text-[14px] font-medium transition-all border"
              style={{
                color: 'var(--bg-white)',
                borderColor: 'var(--clay)',
                background: 'var(--clay)',
                opacity: submitting || !valid ? 0.45 : 1,
                cursor: submitting || !valid ? 'not-allowed' : 'pointer',
              }}
              data-testid="waitlist-submit"
            >
              {submitting ? 'Saving…' : 'Notify me'}
            </button>
            {status === 'error' && (
              <div className="mt-2 text-[12.5px]" data-testid="waitlist-error" style={{ color: 'var(--error)' }}>
                {error}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
