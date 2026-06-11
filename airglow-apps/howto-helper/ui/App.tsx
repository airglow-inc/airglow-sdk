import { useState, useEffect, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, X, Globe } from 'lucide-react';
import { AppPage, SettingsSection } from '../../shared/components';
// the exact brand icon the userscript renders inside the pill
import iconSvg from '../../shared/assets/icon.svg';
declare const airglow: any;

const DOMAINS_KEY = 'page_navigator_domains';

// Entry point + what it opens, styled exactly as the userscript builds them
// (howto-helper/userscripts/main.ts + shared/widgets/chat-window): the
// draggable "How to" pill, and the chat panel that opens above it.
function HowToPillPreview() {
  const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  return (
    <div
      className="rounded-lg px-4 py-4 flex flex-col items-start gap-2"
      style={{ background: 'var(--gray-800)', fontFamily: font }}
    >
      {/* chat panel (opens above the pill) */}
      <div
        style={{
          width: '100%',
          maxWidth: 320,
          background: '#ffffff',
          border: '1.5px solid #e5e3d9',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #edece3', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 17, fontWeight: 600, color: '#3a3a37' }}>Page Navigator</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <span style={{ background: '#eecfd1', color: '#b83636', fontSize: 14, padding: '4px 14px', borderRadius: 20, fontWeight: 500 }}>Clear</span>
            <span style={{ background: '#f3f2ea', border: '1px solid #e5e3d9', color: '#5b5a56', fontSize: 14, padding: '4px 14px', borderRadius: 20, fontWeight: 500 }}>Hide</span>
          </span>
        </div>
        <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ alignSelf: 'flex-end', background: '#6d9ecf', color: '#fff', padding: '6px 10px', borderRadius: '10px 10px 2px 10px', fontSize: 15, lineHeight: 1.5 }}>
            How do I fork this repo?
          </span>
          <span style={{ alignSelf: 'flex-start', background: '#f9f8f3', color: '#3a3a37', padding: '6px 10px', borderRadius: '10px 10px 10px 2px', fontSize: 15, lineHeight: 1.5 }}>
            Click <b>Fork</b> in the top-right, next to Star.
          </span>
        </div>
        <div style={{ padding: '8px 10px', borderTop: '1px solid #edece3', display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <span style={{ flex: 1, border: '1px solid #e5e3d9', borderRadius: 6, padding: '6px 10px', fontSize: 16, background: '#fff', color: '#9a958e' }}>How do I…</span>
          <span style={{ background: '#dc7a5a', color: '#fff', borderRadius: 6, padding: '6px 14px', fontSize: 15, fontWeight: 500 }}>Send</span>
        </div>
      </div>

      {/* the pill (entry point) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px 6px 10px',
          background: '#fff',
          border: '2px solid #e8a050',
          borderRadius: 20,
          cursor: 'grab',
          userSelect: 'none',
          boxShadow: '0 2px 12px rgba(0,0,0,0.10)',
        }}
      >
        <div
          style={{ flexShrink: 0, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          dangerouslySetInnerHTML={{
            __html: iconSvg.replace(/<svg /, '<svg width="18" height="18" style="border-radius:3px;" '),
          }}
        />
        <span style={{ fontSize: 15, color: '#5b5a56', fontWeight: 500, whiteSpace: 'nowrap' }}>How to</span>
      </div>
    </div>
  );
}

function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/:.*$/, '');
}

export default function App() {
  const [domains, setDomains] = useState<string[]>([]);
  const [input, setInput] = useState('');
  useEffect(() => {
    airglow.storage.get(DOMAINS_KEY).then((raw: any) => {
      if (Array.isArray(raw)) setDomains(raw);
      else if (typeof raw === 'string') { try { const p = JSON.parse(raw); if (Array.isArray(p)) setDomains(p); } catch {} }
    });
  }, []);

  function save(next: string[]) {
    setDomains(next);
    airglow.storage.set(DOMAINS_KEY, next);
  }

  function addDomain() {
    const d = normalizeDomain(input);
    if (!d || domains.includes(d)) { setInput(''); return; }
    save([...domains, d]);
    setInput('');
  }

  function removeDomain(d: string) {
    save(domains.filter(x => x !== d));
  }

  return (
    <AppPage
      appId="howto-helper"
      name="How-To Helper"
      description="Adds a floating “How to” button on the websites you choose — click it for an AI chat that explains how to do things on the current page."
      preview={<HowToPillPreview />}
    >
      <SettingsSection title="Websites">
        <p className="text-sm mb-4" style={{ color: 'var(--fg-tertiary)' }}>
          Add websites where the "How to" button should appear. The button is hidden everywhere else.
        </p>

        <div className="flex gap-2 mb-6">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addDomain()}
            placeholder="e.g. github.com"
            className="flex-1 px-4 py-2.5 text-base rounded-sm outline-none"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--fg-primary)',
              border: '1px solid var(--border-secondary)',
            }}
            data-testid="domain-input"
          />
          <button
            onClick={addDomain}
            className="px-4 py-2.5 rounded-sm text-base font-medium flex items-center gap-2 cursor-pointer"
            style={{ background: 'var(--clay)', color: 'white' }}
            data-testid="add-domain"
          >
            <Plus size={16} />
            Add
          </button>
        </div>

        {domains.length === 0 ? (
          <div
            className="rounded-md px-6 py-10 text-center"
            style={{ background: 'var(--bg-white)', boxShadow: 'var(--shadow-card)' }}
          >
            <Globe size={32} className="mx-auto mb-3" style={{ color: 'var(--fg-tertiary)' }} />
            <p className="text-base" style={{ color: 'var(--fg-tertiary)' }}>
              No websites yet. Page Navigator is disabled everywhere.
            </p>
          </div>
        ) : (
          <div className="rounded-md" style={{ background: 'var(--bg-white)', boxShadow: 'var(--shadow-card)' }}>
            {domains.map((d, i) => (
              <div
                key={d}
                className="flex items-center gap-3 px-5 py-3.5"
                style={{ borderBottom: i < domains.length - 1 ? '1px solid var(--border-tertiary)' : 'none' }}
              >
                <Globe size={16} style={{ color: 'var(--clay)' }} />
                <span className="flex-1 text-base font-mono">{d}</span>
                <button
                  onClick={() => removeDomain(d)}
                  className="p-1.5 rounded-sm cursor-pointer"
                  style={{ color: 'var(--fg-tertiary)' }}
                  data-testid={`remove-${d}`}
                  aria-label={`Remove ${d}`}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="text-sm mt-4" style={{ color: 'var(--fg-tertiary)' }}>
          Subdomains of listed sites are included automatically. Changes apply on next page load.
        </p>
      </SettingsSection>
    </AppPage>
  );
}

createRoot(document.getElementById('root')!).render(createElement(App));
