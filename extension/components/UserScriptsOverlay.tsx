// Blocking "Enable User Scripts" gate, shown over the sidepanel AND the
// dashboard whenever Chrome's per-extension "Allow User Scripts" permission is
// off. User Scripts is a hard requirement — without it the extension injects
// nothing — so unlike the dismissible SetupBanners this is a true gate: it
// covers the whole surface, has NO close button (you can't dismiss past the
// issue), and only clears once the permission is actually enabled. The state is
// polled because chrome.userScripts emits no change event.

import { useEffect, useState } from 'react';
import { ExternalLink, FileCode2 } from 'lucide-react';
import { Step } from './SetupBanners';

// Polls whether "Allow User Scripts" is enabled. chrome.userScripts.getScripts()
// throws while the permission is off and resolves once it's granted; the API is
// absent entirely on Chrome < 138. `loaded` gates the first paint so the gate
// never flashes before the first probe resolves.
function useUserScriptsEnabled(): { loaded: boolean; enabled: boolean } {
  const [s, setS] = useState<{ loaded: boolean; enabled: boolean }>({ loaded: false, enabled: false });
  useEffect(() => {
    let alive = true;
    async function probe() {
      let enabled = false;
      if (chrome.userScripts) {
        try { await chrome.userScripts.getScripts(); enabled = true; } catch { enabled = false; }
      }
      if (alive) setS({ loaded: true, enabled });
    }
    void probe();
    const id = setInterval(() => { void probe(); }, 2000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return s;
}

// Opens this extension's chrome://extensions detail page in a new tab.
async function openExtensionSettings() {
  await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

export function UserScriptsOverlay() {
  const { loaded, enabled } = useUserScriptsEnabled();
  if (!loaded || enabled) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-5"
      style={{ background: 'color-mix(in srgb, var(--bg-primary) 82%, transparent)', backdropFilter: 'blur(3px)' }}
      data-testid="userscripts-overlay"
    >
      <UserScriptsCard />
    </div>
  );
}

// The gate's inner card, split out so the design-mock page can render it
// standalone (the overlay above only paints when the permission is actually off).
export function UserScriptsCard() {
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomed(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);

  return (
      <div
        className="w-full max-w-[860px] rounded-sm border p-5"
        style={{
          background: 'color-mix(in srgb, var(--error) 7%, var(--bg-white))',
          borderColor: 'color-mix(in srgb, var(--error) 30%, var(--border-tertiary))',
          boxShadow: '0 12px 40px rgba(17, 17, 16, 0.18)',
        }}
      >
        <div className="text-[19px] font-semibold flex items-center gap-2" style={{ color: 'var(--fg-primary)' }}>
          <FileCode2 size={22} style={{ color: 'var(--error)' }} />
          Enable User Scripts
        </div>
        <div className="flex flex-col gap-2 mt-3.5 text-[16px]" style={{ color: 'var(--fg-secondary)' }}>
          <div className="flex items-center gap-2">
            <Step n={1} />
            <span className="inline-flex items-center gap-1.5">
              Open
              <button
                type="button"
                onClick={() => void openExtensionSettings()}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm border font-medium cursor-pointer"
                style={{ color: 'color-mix(in srgb, var(--sky) 65%, var(--fg-primary))', borderColor: 'color-mix(in srgb, var(--sky) 55%, var(--border-tertiary))', background: 'color-mix(in srgb, var(--sky) 14%, var(--bg-white))' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--sky) 26%, var(--bg-white))'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--sky) 14%, var(--bg-white))'; }}
              >
                Extension Settings
                <ExternalLink size={12} strokeWidth={2.25} />
              </button>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Step n={2} />
            <span>Scroll down and enable <strong>Allow User Scripts</strong></span>
          </div>
        </div>
        <img
          src={chrome.runtime.getURL('userscripts-toggle.png')}
          alt='The "Allow User Scripts" toggle on the extension settings page'
          className="mt-3 w-full rounded-sm border cursor-zoom-in transition-shadow"
          style={{ borderColor: 'color-mix(in srgb, var(--error) 20%, var(--border-tertiary))' }}
          onClick={() => setZoomed(true)}
          onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 4px 16px rgba(17, 17, 16, 0.22)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
        />
        {zoomed && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center p-6 cursor-zoom-out"
            style={{ background: 'rgba(17, 17, 16, 0.65)' }}
            onClick={() => setZoomed(false)}
          >
            <img
              src={chrome.runtime.getURL('userscripts-toggle.png')}
              alt='The "Allow User Scripts" toggle on the extension settings page'
              className="max-w-full max-h-full rounded-sm"
              style={{ boxShadow: '0 24px 80px rgba(0, 0, 0, 0.5)' }}
            />
          </div>
        )}
      </div>
  );
}
