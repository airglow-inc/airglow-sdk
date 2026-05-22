import { useState, useEffect, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Compass, Plus, X, Globe } from 'lucide-react';
declare const airglow: any;

const DOMAINS_KEY = 'page_navigator_domains';

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
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    airglow.storage.get(DOMAINS_KEY).then((raw: any) => {
      if (Array.isArray(raw)) setDomains(raw);
      else if (typeof raw === 'string') { try { const p = JSON.parse(raw); if (Array.isArray(p)) setDomains(p); } catch {} }
      setMounted(true);
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

  if (!mounted) return null;

  return (
    <div className="min-h-screen p-8 font-sans" style={{ background: 'var(--bg-primary)', color: 'var(--fg-primary)' }}>
      <div className="max-w-[600px] mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <Compass size={24} style={{ color: 'var(--clay)' }} />
          <h1 className="text-2xl font-semibold" style={{ letterSpacing: '-0.02em' }}>Page Navigator</h1>
        </div>
        <p className="text-base mb-8" style={{ color: 'var(--fg-tertiary)' }}>
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
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(createElement(App));
