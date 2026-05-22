import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Keyboard, MessageSquare, Trash2, Plus, Settings, ExternalLink, RefreshCw } from 'lucide-react';
import { Card } from '../../shared/components/Card';
import { Input } from '../../shared/components/Input';
import { Textarea } from '../../shared/components/Textarea';
import { Sidebar, NavItem } from '../../shared/components/Sidebar';
import Anthropic from '@anthropic-ai/sdk';
import { marked } from 'marked';
import Chat, { PROSE_CSS } from './chat';

marked.setOptions({ breaks: true, gfm: true });

declare const airglow: any;
declare const window: any;

// ── Types ──

interface SearchMode {
  name: string;
  system: string;
  format: string;
  inputLabel: string;
  example?: { context: string; term: string; response: string };
}

const DEFAULT_MODES: SearchMode[] = [
  {
    name: 'Explain',
    system: 'Explain what the term means in the given context. Give the meaning, then 2-3 example sentences with the **term** in bold.\n\nFormat:\n**Meaning:** explanation of the term\n\n**Examples:**\n- Example sentence with **term** in bold\n- Another example with **term** in bold',
    format: 'Context',
    inputLabel: 'Term',
    example: {
      context: 'After the tailgate, we grabbed some PBRs and watched the game from the nosebleeds',
      term: 'nosebleeds',
      response: '"Nosebleeds" refers to the cheapest seats in a stadium, located in the highest rows far from the field — so high up you might jokingly get a nosebleed from the altitude.',
    },
  },
  {
    name: 'Translate',
    system: 'Translate into French. Give 3 examples of how the phrase is used, similar to context reverso website.\n\nFormat:\n**Meaning:** meaning in english\n**Translation:** translated phrase\n\n**Examples:**\n| English | French |\n|---|---|\n| example sentence with **phrase** | traduction avec **phrase** |',
    format: 'Context',
    inputLabel: 'phrase',
    example: {
      context: 'Email from a colleague about project deadlines',
      term: 'Let me circle back on this after the standup',
      response: '**Meaning:** To revisit or follow up on a topic later\n**Translation:** Laisse-moi revenir là-dessus après le standup\n\n**Examples:**\n| English | French |\n|---|---|\n| Let me **circle back** on this tomorrow | Laisse-moi **revenir là-dessus** demain |\n| We\'ll **circle back** after the review | On **reviendra là-dessus** après la revue |\n| Can we **circle back** on pricing next week? | On peut **revenir sur les prix** la semaine prochaine ? |',
    },
  },
  {
    name: 'Rephrase',
    system: 'Suggest 3 more elegant alternatives that fit the context. List them with the relevant **phrase** in bold.\n\nFormat:\n- **Elegant phrase** — brief note on tone/register\n- **Another phrase** — brief note\n- **Third phrase** — brief note',
    format: 'Context',
    inputLabel: 'Phrase',
    example: {
      context: 'Writing a professional email to a client',
      term: 'I think we should probably maybe consider',
      response: '• We recommend considering\n• It would be worth exploring\n• We suggest evaluating',
    },
  },
];

const DEFAULT_SHORTCUT = 'ctrl+j';

const SHORTCUT_OPTIONS = [
  { combo: 'ctrl+j', label: 'Ctrl + J' },
  { combo: 'ctrl+e', label: 'Ctrl + E' },
  { combo: 'ctrl+k', label: 'Ctrl + K' },
];

/** Parse "meta+shift+k" → { meta, shift, ctrl, alt, key } */
function parseCombo(combo: string) {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  return {
    meta: parts.includes('meta'),
    shift: parts.includes('shift'),
    ctrl: parts.includes('ctrl'),
    alt: parts.includes('alt'),
    key,
  };
}

/** Format combo string for display: "meta+shift+k" → "⌃ + ⇧ + K" */
function displayCombo(combo: string): string {
  const p = parseCombo(combo);
  const parts: string[] = [];
  if (p.meta) parts.push('Ctrl');
  if (p.ctrl) parts.push('Ctrl');
  if (p.alt) parts.push('⌥');
  if (p.shift) parts.push('⇧');
  parts.push(p.key.toUpperCase());
  return parts.join('\u2009+\u2009');
}


// ── Custom shortcut capture ──

function CustomShortcutInput({ active, currentCombo, onChange }: {
  active: boolean;
  currentCombo: string;
  onChange: (combo: string) => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const currentKey = active ? parseCombo(currentCombo).key : '';

  useEffect(() => {
    if (!waiting) return;
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') { setWaiting(false); return; }
      if (e.key.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        onChange(`meta+${e.key.toLowerCase()}`);
        setWaiting(false);
      }
    }
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [waiting]);

  if (waiting) {
    return (
      <button
        className="h-9 px-4 rounded-full text-base font-medium animate-pulse"
        style={{
          background: 'color-mix(in srgb, var(--clay) 10%, transparent)',
          color: 'var(--clay)',
          border: '1.5px dashed var(--clay)',
        }}
      >
        <span style={{fontSize:'0.85em'}}>Ctrl</span>{'\u2009'}+{'\u2009'}…
      </button>
    );
  }

  return (
    <button
      onClick={() => setWaiting(true)}
      className="h-9 px-4 rounded-full text-base font-medium cursor-pointer transition-all"
      style={{
        background: active ? 'color-mix(in srgb, var(--clay) 15%, transparent)' : 'var(--bg-white)',
        color: active ? 'var(--clay)' : 'var(--fg-secondary)',
        border: active ? '1.5px solid var(--clay)' : '1px solid var(--border-secondary)',
      }}
    >
      <span style={{fontSize:'0.85em'}}>Ctrl</span>{'\u2009'}+{'\u2009'}{active ? currentKey.toUpperCase() : '?'}
    </button>
  );
}

// ── Mode detail panel ──

function ModeDetail({ mode, index, totalModes, onUpdate, onUpdateExample, onRemove, Kbd }: {
  mode: SearchMode | undefined;
  index: number;
  totalModes: number;
  onUpdate: (field: keyof SearchMode, value: string) => void;
  onUpdateExample: (example: SearchMode['example']) => void;
  onRemove: () => void;
  Kbd: React.ComponentType<{ children: React.ReactNode }>;
}) {
  const [generating, setGenerating] = useState(false);

  async function generateExample() {
    if (!mode || !mode.system.trim()) return;
    setGenerating(true);
    try {
      const apiKey = await airglow.storage.get('ANTHROPIC_API_KEY');
      if (!apiKey) { setGenerating(false); return; }

      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      const res = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        temperature: 1,
        messages: [{
          role: 'user',
          content: `Generate one realistic example for a tool with this system prompt:\n"${mode.system}"${mode.format?.trim() ? `\n\nOutput format:\n${mode.format.trim()}` : ''}\n\nThe tool takes two inputs:\n- "Context": provides context for the query\n- "${mode.inputLabel}": the main query\n\nRespond in JSON only, no markdown:\n{"context": "...", "term": "...", "response": "..."}\n\nwhere "context" is the context, "term" maps to "${mode.inputLabel}", and "response" is what the system would output. Use \\n newlines in the response field to separate distinct lines (e.g. meaning, translation, examples). Keep all values concise.`,
        }],
      });

      let text = (res.content[0] as any).text.trim();
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(text);
      onUpdateExample({ context: parsed.context, term: parsed.term, response: parsed.response });
    } catch (e: any) {
      airglow.log.error('askme-anything', { error: e.message, action: 'generateExample' });
    }
    setGenerating(false);
  }

  if (!mode) return null;
  const ex = mode.example;

  return (
    <>
      <Card className="p-5">
        {/* Top row: Shortcut, Title, Input Label, Delete */}
        <div className="flex items-end gap-4 mb-4">
          <div style={{ minWidth: '90px' }}>
            <label className="block text-sm font-semibold mb-1" style={{ color: 'var(--fg-secondary)' }}>Shortcut</label>
            <div style={{ height: '36px', display: 'flex', alignItems: 'center' }}>
              <Kbd><span style={{fontSize:'0.85em'}}>Ctrl</span>{'\u2009'}+{'\u2009'}{index + 1}</Kbd>
            </div>
          </div>
          <div className="flex-1">
            <label className="block text-base font-semibold mb-1" style={{ color: 'color-mix(in srgb, var(--clay) 60%, var(--fg-secondary))' }}>Mode title</label>
            <Input value={mode.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onUpdate('name', e.target.value)} className="font-medium text-sm" style={{ borderColor: 'color-mix(in srgb, var(--clay) 50%, var(--border-secondary))', borderWidth: '2px', height: '36px' }} />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-semibold mb-1" style={{ color: 'var(--fg-secondary)' }}>Input label</label>
            <Input value={mode.inputLabel} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onUpdate('inputLabel', e.target.value)} className="text-sm" style={{ height: '36px' }} />
          </div>
          <button
            onClick={onRemove}
            disabled={totalModes <= 1}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm cursor-pointer disabled:opacity-30 transition-colors flex-shrink-0"
            style={{ background: 'color-mix(in srgb, var(--error) 8%, transparent)', color: 'var(--error)', border: '1px solid color-mix(in srgb, var(--error) 25%, transparent)', height: '36px' }}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
        {/* Second row: System prompt (left) + Format (right) */}
        <div className="flex gap-4">
          <div style={{ flex: 1 }}>
            <label className="block text-sm font-semibold mb-1" style={{ color: 'var(--fg-secondary)' }}>System prompt</label>
            <Textarea
              value={mode.system}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate('system', e.target.value)}
              style={{ minHeight: '180px', fontSize: '14px' }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label className="block text-sm font-semibold mb-1" style={{ color: 'var(--fg-secondary)' }}>Output format</label>
            <Textarea
              value={mode.format}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate('format', e.target.value)}
              style={{ minHeight: '180px', fontSize: '14px' }}
            />
          </div>
        </div>
      </Card>

      {ex && (
        <div className="mt-4 rounded-lg p-4 text-base" style={{ background: 'var(--bg-tertiary)' }}>
          <style dangerouslySetInnerHTML={{ __html: PROSE_CSS }} />
          <div className="mb-3 font-medium" style={{ color: 'var(--fg-tertiary)' }}>Example</div>
          <div className="mb-2" style={{ color: 'var(--fg-secondary)' }}>
            <span style={{ color: 'var(--fg-tertiary)' }}>Context:</span>{' '}
            <span dangerouslySetInnerHTML={{
              __html: ex.context.replace(
                new RegExp(`(${ex.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i'),
                '<mark style="background:color-mix(in srgb, var(--clay) 20%, transparent);border-radius:2px;padding:0 2px">$1</mark>'
              )
            }} />
          </div>
          <div className="mb-3" style={{ color: 'var(--fg-secondary)' }}>
            <span style={{ color: 'var(--fg-tertiary)' }}>{mode.inputLabel}:</span>{' '}
            <strong>{ex.term}</strong>
          </div>
          <div
            className="askme-prose border-t pt-3"
            style={{ borderColor: 'var(--border-secondary)', color: 'var(--fg-primary)' }}
            dangerouslySetInnerHTML={{ __html: marked.parse(ex.response) as string }}
          />
        </div>
      )}

      <button
        onClick={generateExample}
        disabled={generating || !mode.system.trim()}
        className="mt-3 self-start inline-flex items-center gap-2 px-5 py-2 rounded-full text-base cursor-pointer disabled:opacity-40 transition-colors"
        style={{
          background: 'var(--bg-white)',
          color: 'var(--fg-secondary)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <RefreshCw size={16} className={generating ? 'animate-spin' : ''} />
        {generating ? 'Generating…' : 'Generate example'}
      </button>
    </>
  );
}

// ── Dashboard ──

function Dashboard() {
  const [modes, setModes] = useState<SearchMode[]>([]);
  const [shortcut, setShortcut] = useState(DEFAULT_SHORTCUT);
  const [selectedMode, setSelectedMode] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  useEffect(() => {
    (window as any).__test = { setModes };
    return () => { delete (window as any).__test; };
  }, []);

  useEffect(() => {
    (async () => {
      const stored = await airglow.storage.get('askme_modes');
      setModes(stored && stored.length > 0 ? stored : DEFAULT_MODES);
      const sc = await airglow.storage.get('askme_shortcut');
      if (sc) {
        const combo = sc.includes('+') ? sc : `meta+${sc}`;
        setShortcut(combo);
      }
      setLoaded(true);
    })();
  }, []);

  // Auto-save on any change
  useEffect(() => {
    if (!loaded) return;
    airglow.storage.set('askme_modes', modes);
  }, [modes, loaded]);

  useEffect(() => {
    if (!loaded) return;
    airglow.storage.set('askme_shortcut', shortcut);
  }, [shortcut, loaded]);

  function updateMode(i: number, field: keyof SearchMode, value: string) {
    const updated = [...modes];
    updated[i] = { ...updated[i], [field]: value };
    setModes(updated);
  }

  function addMode() {
    setModes([...modes, { name: 'New Mode', system: '', format: 'Context', inputLabel: 'Query' }]);
  }

  function removeMode(i: number) {
    if (modes.length <= 1) return;
    setModes(modes.filter((_, idx) => idx !== i));
  }

  function openChat() {
    const url = `chrome-extension://comikpjjijckpjkobpkkpnnhlcpmagic/app-shell.html?app=askme-anything&page=chat&edge=0`;
    airglow.openWindow(url, { width: 840, height: 600, popup: true });
  }

  const Kbd = ({ children }: { children: React.ReactNode }) => (
    <kbd className="inline-flex items-center justify-center font-mono text-base px-2 py-0.5 rounded border border-stone-300 bg-stone-100 text-stone-600 whitespace-nowrap">
      {children}
    </kbd>
  );

  return (
    <div className="flex min-h-screen font-sans" style={{ background: 'var(--bg-primary)', color: 'var(--fg-primary)' }}>
      <Sidebar title="Ask Me Anything">
        <NavItem icon={Settings} label="Settings" active />
        <NavItem
          icon={MessageSquare}
          label="Chat"
          onClick={openChat}
          trailing={<ExternalLink size={12} style={{ opacity: 0.4 }} />}
        />
      </Sidebar>

      <div className="flex-1 flex flex-col min-h-0">
        <main className="flex-1 overflow-y-auto p-6 pb-0 thin-scroll">
          <div className="grid gap-8 min-h-full" style={{ gridTemplateColumns: '2fr 3fr' }}>
            {/* Left column */}
            <div className="space-y-6">
              {/* How it works */}
              <Card>
                <h2 className="text-base font-semibold mb-3" style={{ color: 'var(--fg-primary)' }}>How it works</h2>
                <ol className="text-base space-y-2 list-decimal list-inside" style={{ color: 'var(--fg-secondary)' }}>
                  <li><strong>Highlight text</strong> on any page and press the <strong>trigger shortcut</strong></li>
                  <li>A <strong>search bar</strong> appears at the bottom with your configured <strong>modes</strong></li>
                  <li>Type your query and press <strong>Enter</strong> — a <strong>chat window</strong> opens with an AI answer</li>
                  <li>Ask <strong>follow-up questions</strong> in the same conversation</li>
                </ol>
                <div className="space-y-2 text-base mt-4" style={{ color: 'var(--fg-secondary)' }}>
                  <div className="flex items-center gap-3">
                    <span className="flex-shrink-0"><Kbd><span style={{fontSize:'0.85em'}}>Ctrl</span>{'\u2009'}+{'\u2009'}{parseCombo(shortcut).key.toUpperCase()}</Kbd></span>
                    <span>Open the search bar</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex-shrink-0"><Kbd><span style={{fontSize:'0.85em'}}>Ctrl</span>{'\u2009'}+{'\u2009'}I</Kbd></span>
                    <span>Cycle between modes</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex-shrink-0"><Kbd><span style={{fontSize:'0.85em'}}>Ctrl</span>{'\u2009'}+{'\u2009'}1</Kbd> – <Kbd><span style={{fontSize:'0.85em'}}>Ctrl</span>{'\u2009'}+{'\u2009'}9</Kbd></span>
                    <span>Jump to a mode directly</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex-shrink-0"><Kbd>Enter</Kbd></span>
                    <span>Submit query</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex-shrink-0"><Kbd>Esc</Kbd></span>
                    <span>Close the bar</span>
                  </div>
                </div>
              </Card>

              {/* Trigger shortcut */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Keyboard size={18} style={{ color: 'var(--fg-tertiary)' }} />
                  <h2 className="text-base font-semibold">Trigger shortcut</h2>
                </div>
                <div className="flex gap-2 flex-wrap items-center">
                  {SHORTCUT_OPTIONS.map(opt => {
                    const isActive = shortcut === opt.combo;
                    return (
                      <button
                        key={opt.combo}
                        onClick={() => setShortcut(opt.combo)}
                        className="h-9 px-4 rounded-full text-base font-medium cursor-pointer transition-all"
                        style={{
                          background: isActive ? 'color-mix(in srgb, var(--clay) 15%, transparent)' : 'var(--bg-white)',
                          color: isActive ? 'var(--clay)' : 'var(--fg-secondary)',
                          border: isActive ? '1.5px solid var(--clay)' : '1px solid var(--border-secondary)',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                  <span className="text-sm mx-1" style={{ color: 'var(--fg-tertiary)' }}>or</span>
                  <CustomShortcutInput
                    active={!SHORTCUT_OPTIONS.some(o => o.combo === shortcut)}
                    currentCombo={shortcut}
                    onChange={(combo: string) => setShortcut(combo)}
                  />
                </div>
              </section>

            </div>

            {/* Right column — Modes */}
            <div className="flex flex-col border-l pl-8" style={{ borderColor: 'var(--border-secondary)' }}>
              <div className="flex items-center gap-2 mb-4">
                <MessageSquare size={18} style={{ color: 'var(--fg-tertiary)' }} />
                <h2 className="text-base font-semibold">Modes</h2>
              </div>
              {/* Mode selector tabs — draggable */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                {modes.map((mode, i) => (
                  <button
                    key={mode.name + i}
                    draggable
                    onDragStart={() => setDragFrom(i)}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(i); }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={() => {
                      if (dragFrom !== null && dragFrom !== i) {
                        const updated = [...modes];
                        const [moved] = updated.splice(dragFrom, 1);
                        updated.splice(i, 0, moved);
                        setModes(updated);
                        setSelectedMode(i);
                      }
                      setDragFrom(null);
                      setDragOver(null);
                    }}
                    onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
                    onClick={() => setSelectedMode(i)}
                    className="h-9 px-4 rounded-full text-base cursor-grab active:cursor-grabbing transition-all flex items-center gap-2"
                    style={{
                      background: selectedMode === i ? 'color-mix(in srgb, var(--clay) 15%, transparent)' : 'var(--bg-white)',
                      color: selectedMode === i ? 'var(--clay)' : 'var(--fg-secondary)',
                      border: selectedMode === i ? '1.5px solid var(--clay)'
                        : dragOver === i ? '1.5px dashed var(--clay)'
                        : '1px solid var(--border-primary)',
                      fontWeight: selectedMode === i ? 600 : 400,
                      opacity: dragFrom === i ? 0.5 : 1,
                    }}
                  >
                    <span className="text-sm font-mono" style={{ opacity: 0.6 }}><span style={{fontSize:'0.85em'}}>Ctrl</span>{'\u2009'}+{'\u2009'}{i + 1}</span>
                    {mode.name}
                  </button>
                ))}
                <button
                  onClick={() => { addMode(); setSelectedMode(modes.length); }}
                  className="h-9 w-9 rounded-full flex items-center justify-center cursor-pointer"
                  style={{ color: 'var(--fg-tertiary)', border: '1px solid var(--border-secondary)' }}
                >
                  <Plus size={16} />
                </button>
              </div>

              {/* Selected mode details */}
              <ModeDetail
                mode={modes[selectedMode]}
                index={selectedMode}
                totalModes={modes.length}
                onUpdate={(field: keyof SearchMode, value: string) => updateMode(selectedMode, field, value)}
                onUpdateExample={(example: SearchMode['example']) => {
                  const updated = [...modes];
                  updated[selectedMode] = { ...updated[selectedMode], example };
                  setModes(updated);
                }}
                onRemove={() => { removeMode(selectedMode); setSelectedMode(Math.max(0, selectedMode - 1)); }}
                Kbd={Kbd}
              />
            </div>
          </div>
        </main>

      </div>
    </div>
  );
}

// ── Router ──

function Root() {
  const params = window.__airglow_params || {};
  if (params.page === 'chat') {
    return <Chat />;
  }
  return <Dashboard />;
}

createRoot(document.getElementById('root')!).render(<Root />);
