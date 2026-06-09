import { useState, useEffect, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AppPage, SettingsSection } from '../../shared/components';
// the exact brand icon the userscript renders inside the button
import iconSvg from '../../shared/assets/icon.svg';
declare const airglow: any;

// The "Create Meeting" button, styled exactly as the userscript builds it
// (gmail-calendar/userscripts/gmail.ts — blue outline pill with the brand
// icon, Gmail's Google Sans), plus the flow it triggers.
function GmailFlowPreview() {
  return (
    <div className="flex items-center gap-3 flex-wrap text-sm" style={{ color: 'var(--fg-secondary)' }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 36,
          padding: '0 16px 0 11px',
          border: '2px solid #2563eb',
          borderRadius: 18,
          color: '#2563eb',
          fontFamily: "'Google Sans', Roboto, RobotoDraft, Helvetica, Arial, sans-serif",
          fontSize: 14,
          fontWeight: 500,
          background: 'transparent',
          lineHeight: 1,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span
          style={{ display: 'inline-flex', width: 20, height: 20, marginRight: 8, alignItems: 'center', justifyContent: 'center' }}
          dangerouslySetInnerHTML={{ __html: iconSvg }}
        />
        Create Meeting
      </span>
      <span style={{ color: 'var(--fg-tertiary)' }}>added next to Reply/Forward in Gmail</span>
      <span aria-hidden>→</span>
      <span>AI extracts title, time &amp; attendees</span>
      <span aria-hidden>→</span>
      <span>Google Calendar opens pre-filled</span>
    </div>
  );
}

/* ── Inline components (no shared dep) ── */
function Button({ className = '', variant = 'primary', size = 'md', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) {
  const v = variant === 'secondary' ? 'bg-stone-200 text-stone-600 border border-stone-300 hover:bg-stone-100' : 'bg-stone-900 text-stone-50 hover:bg-stone-800';
  const s = size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-9 px-4 text-sm';
  return <button className={`inline-flex items-center justify-center rounded-full font-medium cursor-pointer disabled:opacity-50 ${v} ${s} ${className}`} {...p} />;
}
function Card({ className = '', padding = 'default', ...p }: React.HTMLAttributes<HTMLDivElement> & { padding?: string }) {
  return <div className={`bg-white border border-stone-200 rounded-md ${padding === 'default' ? 'p-4' : padding === 'compact' ? 'p-3' : ''} ${className}`} style={{ boxShadow: 'var(--shadow-card)' }} {...p} />;
}
function Badge({ className = '', variant = 'default', ...p }: React.HTMLAttributes<HTMLSpanElement> & { variant?: string }) {
  const v: Record<string, string> = {
    default: 'bg-stone-100 text-stone-600',
    success: 'bg-[color-mix(in_srgb,var(--olive)_15%,transparent)] text-[var(--olive)]',
    error: 'bg-[color-mix(in_srgb,var(--error)_15%,transparent)] text-[var(--error)]',
  };
  return <span className={`inline-flex items-center rounded-xs px-2 py-0.5 text-xs font-medium ${v[variant] || v.default} ${className}`} {...p} />;
}

interface LogEntry {
  reqId: string;
  ts: string;
  type: string;
  title?: string;
  model?: string;
  subject?: string;
  participants?: string;
  prompt?: string;
  raw?: string;
  result?: Record<string, unknown>;
  error?: string;
  [key: string]: any;
}

function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function fetchLogs() {
    setLoading(true);
    try {
      const entries: LogEntry[] = (await airglow.storage.get('extraction_logs')) || [];
      // Most recent first
      setLogs([...entries].reverse());
    } catch {
      setLogs([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  function toggle(reqId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(reqId)) next.delete(reqId);
      else next.add(reqId);
      return next;
    });
  }

  return (
    <AppPage
      appId="gmail-calendar"
      name="Gmail Calendar"
      description="Reads email conversations and uses AI to pre-fill Google Calendar events. Click “Create Meeting” next to Reply/Forward in Gmail to extract meeting details."
      preview={<GmailFlowPreview />}
      secrets={[{
        name: 'COMPOSIO_API_KEY',
        note: 'server-side key — set it in the workspace .env (not in the extension); the dev server warns at startup when it is missing.',
      }]}
    >
      <SettingsSection title="Extraction Log">
        <div className="flex justify-end mb-4 -mt-12">
          <Button variant="secondary" size="sm" onClick={fetchLogs} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </Button>
        </div>

        {/* Log entries */}
        {logs.length === 0 ? (
          <p className="text-sm text-stone-600">No log entries yet. Use the Create Meeting button in Gmail to generate entries.</p>
        ) : (
          <div className="space-y-3">
            {logs.map((g) => {
              const isOpen = expanded.has(g.reqId);
              const hasError = g.type === 'error';

              return (
                <Card key={g.reqId} padding="none" className="rounded-[0.75rem] overflow-hidden">
                  {/* Clickable header */}
                  <div
                    className="px-5 py-4 cursor-pointer hover:bg-stone-50 flex items-center justify-between transition-colors"
                    onClick={() => toggle(g.reqId)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Badge variant={hasError ? 'error' : 'success'} className="font-mono flex-shrink-0">
                        {hasError ? 'error' : 'ok'}
                      </Badge>
                      <span className="text-sm font-medium text-stone-900 truncate">
                        {g.title || g.subject || 'Extraction'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-xs text-stone-600">
                        {new Date(g.ts).toLocaleTimeString()}
                      </span>
                      <span className="text-stone-600 text-xs">{isOpen ? '\u25B2' : '\u25BC'}</span>
                    </div>
                  </div>

                  {/* Expanded detail */}
                  {isOpen && (
                    <div className="px-5 pb-4 border-t border-stone-200 pt-3 space-y-3">
                      {g.model && (
                        <div>
                          <div className="text-xs font-semibold text-stone-600 mb-1">Model</div>
                          <code className="text-xs font-mono text-stone-900 bg-stone-50 px-2 py-0.5 rounded-[var(--radius-sm)]">{g.model}</code>
                        </div>
                      )}

                      {(g.subject || g.participants) && (
                        <div>
                          <div className="text-xs font-semibold text-stone-600 mb-1">Metadata</div>
                          <div className="text-sm bg-stone-50 p-3 rounded-[var(--radius-sm)]">
                            {g.subject && <div><span className="text-stone-600">Subject:</span> {g.subject}</div>}
                            {g.participants && (
                              <div className="whitespace-pre-wrap">
                                <span className="text-stone-600">Participants:</span>{'\n'}{g.participants}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {g.prompt && (
                        <details className="text-xs">
                          <summary className="font-semibold text-stone-600 cursor-pointer">Full Prompt</summary>
                          <pre className="bg-stone-50 p-3 rounded-[var(--radius-sm)] font-mono text-xs whitespace-pre-wrap mt-1" style={{ maxHeight: 300, overflow: 'auto' }}>
                            {g.prompt}
                          </pre>
                        </details>
                      )}

                      {g.raw && (
                        <div>
                          <div className="text-xs font-semibold text-stone-600 mb-1">LLM Response</div>
                          <pre className="text-xs bg-stone-50 p-3 rounded-[var(--radius-sm)] font-mono overflow-x-auto text-stone-900 whitespace-pre-wrap" style={{ maxHeight: 200, overflow: 'auto' }}>
                            {g.raw}
                          </pre>
                        </div>
                      )}

                      {g.result && (
                        <div>
                          <div className="text-xs font-semibold text-stone-600 mb-1">Parsed Result</div>
                          <pre className="text-xs bg-stone-50 p-3 rounded-[var(--radius-sm)] font-mono overflow-x-auto text-stone-900">
                            {JSON.stringify(g.result, null, 2)}
                          </pre>
                        </div>
                      )}

                      {g.error && (
                        <div>
                          <div className="text-xs font-semibold text-stone-600 mb-1">Error</div>
                          <pre className="text-xs bg-[color-mix(in_srgb,var(--error)_8%,transparent)] p-3 rounded-[var(--radius-sm)] font-mono overflow-x-auto text-[var(--error)]">
                            {g.error}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </AppPage>
  );
}

createRoot(document.getElementById('root')!).render(createElement(App));
