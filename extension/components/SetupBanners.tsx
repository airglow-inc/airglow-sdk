// Chrome-setup nags shown at the top of the sidepanel, next to the
// host-missing onboarding banner: "Enable User Scripts" (the extension can't
// inject anything without it) and "Add Airglow shortcut" (pin the toolbar
// icon). Each detects its own state and renders nothing once satisfied.
// Append ?debug-banners=1 to force both visible.

import { useEffect, useState } from 'react';
import { FileCode2, Pin, TriangleAlert, X } from 'lucide-react';

// Pin is a convenience, not a blocker — once dismissed it stays dismissed
// across sessions (it still auto-hides the moment the icon is pinned).
const PIN_DISMISSED_KEY = '__pin_banner_dismissed';

function PuzzleIcon({ size = 16, color = 'currentColor', className = '' }: { size?: number; color?: string; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 -960 960 960" fill={color} className={className} aria-hidden="true">
      <path d="M352-120H200q-33 0-56.5-23.5T120-200v-152q48 0 84-30.5t36-77.5q0-47-36-77.5T120-568v-152q0-33 23.5-56.5T200-800h160q0-42 29-71t71-29q42 0 71 29t29 71h160q33 0 56.5 23.5T800-720v160q42 0 71 29t29 71q0 42-29 71t-71 29v160q0 33-23.5 56.5T720-120H568q0-50-31.5-85T460-240q-45 0-76.5 35T352-120Zm-152-80h85q24-66 77-93t98-27q45 0 98 27t77 93h85v-240h80q8 0 14-6t6-14q0-8-6-14t-14-6h-80v-240H480v-80q0-8-6-14t-14-6q-8 0-14 6t-6 14v80H200v88q54 20 87 67t33 105q0 57-33 104t-87 68v88Zm260-260Z" />
    </svg>
  );
}

function Step({ n }: { n: number }) {
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

export function SetupBanners({ force = false }: { force?: boolean } = {}) {
  const [userScriptsEnabled, setUserScriptsEnabled] = useState<boolean | null>(null);
  const [isPinned, setIsPinned] = useState<boolean | null>(null);
  const [pinDismissed, setPinDismissed] = useState(false);
  const forceBanners = force || new URLSearchParams(window.location.search).get('debug-banners') === '1';

  useEffect(() => {
    if (chrome.userScripts) {
      chrome.userScripts.getScripts().then(() => setUserScriptsEnabled(true)).catch(() => setUserScriptsEnabled(false));
    } else {
      setUserScriptsEnabled(false);
    }
    chrome.action?.getUserSettings?.().then((s) => setIsPinned(s.isOnToolbar));
    chrome.storage?.local?.get(PIN_DISMISSED_KEY).then((r) => { if (r?.[PIN_DISMISSED_KEY]) setPinDismissed(true); });
  }, []);

  function dismissPin() {
    setPinDismissed(true);
    chrome.storage?.local?.set({ [PIN_DISMISSED_KEY]: true });
  }

  return (
    <>
      {(forceBanners || userScriptsEnabled === false) && (
        <div className="m-3 p-3.5 rounded-xl border" style={cardStyle} data-testid="banner-userscripts">
          <div className="text-[15px] font-semibold flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
            <FileCode2 size={18} style={{ color: 'var(--error)' }} />
            Enable User Scripts
          </div>
          <div className="flex flex-col gap-1.5 mt-3 text-[14px]" style={{ color: 'var(--fg-secondary)' }}>
            <div className="flex items-center gap-2">
              <Step n={1} />
              <span>
                Open{' '}
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }); }}
                  style={{ color: 'var(--clay)' }}
                >Extension Settings</a>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Step n={2} />
              <span>Scroll down and enable <strong>User scripts</strong></span>
            </div>
            <div className="flex items-center gap-2">
              <Step n={3} />
              <span>Reload this page</span>
            </div>
          </div>
          <div
            className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border"
            style={{ borderColor: 'var(--error)', background: 'color-mix(in srgb, var(--error) 18%, var(--bg-white))', color: 'var(--fg-secondary)', fontSize: '13px' }}
          >
            <TriangleAlert size={15} className="shrink-0" style={{ color: 'var(--error)' }} />
            <span>Airglow won't run until User Scripts are enabled.</span>
          </div>
        </div>
      )}

      {(forceBanners || (isPinned === false && !pinDismissed)) && (
        <div className="relative m-3 p-3.5 rounded-xl border" style={cardStyle} data-testid="banner-pin">
          <button
            onClick={dismissPin}
            aria-label="Dismiss"
            data-testid="banner-pin-dismiss"
            className="absolute top-2.5 right-2.5 inline-flex items-center justify-center h-6 w-6 rounded cursor-pointer"
            style={{ background: 'transparent', color: 'var(--fg-tertiary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gray-200)'; e.currentTarget.style.color = 'var(--fg-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-tertiary)'; }}
          >
            <X size={14} strokeWidth={2.5} />
          </button>
          <div className="text-[15px] font-semibold flex items-center gap-2 pr-7" style={{ color: 'var(--fg-primary)' }}>
            <Pin size={18} style={{ color: 'var(--error)' }} />
            Add Airglow shortcut
          </div>
          <div className="flex flex-col gap-1.5 mt-3 text-[14px]" style={{ color: 'var(--fg-secondary)' }}>
            <div className="flex items-start gap-2">
              <Step n={1} />
              <span className="inline-flex items-center gap-1 flex-wrap">
                Click <PuzzleIcon size={18} className="inline-block shrink-0" color="var(--fg-primary)" /> icon <strong>(Extensions)</strong> in Chrome's toolbar
              </span>
            </div>
            <div className="flex items-start gap-2">
              <Step n={2} />
              <span className="inline-flex items-center gap-1 flex-wrap">
                Click <Pin size={18} className="inline-block shrink-0" style={{ color: 'var(--fg-primary)' }} /> icon next to <strong>Airglow</strong>
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
