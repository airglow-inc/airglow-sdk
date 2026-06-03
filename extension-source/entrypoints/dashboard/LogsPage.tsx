import { useState, useEffect, useRef } from 'react';
import { RefreshCw, ChevronDown, AlertTriangle, AlertCircle, Info, Search } from 'lucide-react';

const LAST_SEEN_KEY = '__logs_last_seen_ts';

interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
  stack?: string;
}

const LEVEL_CONFIG = {
  error: { icon: AlertCircle, color: 'var(--error)', bg: 'color-mix(in srgb, var(--error) 10%, transparent)' },
  warn: { icon: AlertTriangle, color: 'var(--clay)', bg: 'color-mix(in srgb, var(--clay) 10%, transparent)' },
  info: { icon: Info, color: 'var(--fg-tertiary)', bg: 'transparent' },
} as const;

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const mon = d.toLocaleDateString('en-US', { month: 'short' });
  const day = d.getDate();
  const time = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${mon} ${day} ${time}`;
}

export default function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<'all' | 'error' | 'warn' | 'info'>('error');
  const [sourceMode, setSourceMode] = useState<'all' | 'extension' | 'apps'>('all');
  const [appFilter, setAppFilter] = useState<string>('all');
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [now, setNow] = useState(() => new Date());
  // Snapshotted at mount so "New" pills don't disappear as user reads.
  // null = not loaded yet (don't flash pills on every row before storage resolves).
  const [seenCutoff, setSeenCutoff] = useState<number | null>(null);
  const markedRef = useRef(false);

  function loadLogs() {
    chrome.runtime.sendMessage({ type: 'airglow:logs:get' }, (res) => {
      if (res?.entries) setEntries(res.entries);
    });
  }

  useEffect(() => {
    loadLogs();
    chrome.storage.local.get(LAST_SEEN_KEY, (res: Record<string, any>) => {
      setSeenCutoff((res[LAST_SEEN_KEY] as number | undefined) ?? 0);
    });
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Mark as seen once after the first batch of entries arrives.
  useEffect(() => {
    if (markedRef.current || seenCutoff === null || entries.length === 0) return;
    markedRef.current = true;
    const maxTs = entries.reduce((m, e) => (e.ts > m ? e.ts : m), 0);
    if (maxTs > seenCutoff) chrome.storage.local.set({ [LAST_SEEN_KEY]: maxTs });
  }, [entries, seenCutoff]);

  useEffect(() => {
    const id = setInterval(loadLogs, 3000);
    return () => clearInterval(id);
  }, []);

  // Compute app sources (everything except 'airglow')
  const appSources = Array.from(new Set(entries.filter(e => e.source !== 'airglow').map(e => e.source))).sort();

  const searchLower = searchQuery.trim().toLowerCase();

  // Apply filters
  const filtered = entries.filter(e => {
    if (levelFilter !== 'all' && e.level !== levelFilter) return false;
    if (sourceMode === 'extension' && e.source !== 'airglow') return false;
    if (sourceMode === 'apps') {
      if (e.source === 'airglow') return false;
      if (appFilter !== 'all' && e.source !== appFilter) return false;
    }
    if (searchLower && !e.message.toLowerCase().includes(searchLower) && !e.source.toLowerCase().includes(searchLower) && !(e.stack && e.stack.toLowerCase().includes(searchLower))) return false;
    return true;
  });

  // Count by level
  const counts = { error: 0, warn: 0, info: 0 };
  for (const e of entries) counts[e.level]++;

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 64px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h2 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--fg-primary)' }}>
          Logs
        </h2>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-base tabular-nums font-medium" style={{ color: 'var(--fg-primary)', fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)' }}>
            {now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <button
            onClick={loadLogs}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border"
            style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
            data-testid="logs-refresh"
          >
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>
      </div>

      {/* Search + Filters */}
      <div className="flex items-center gap-3 mb-3 shrink-0">
        {/* Search */}
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--fg-tertiary)' }} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search logs..."
            className="h-8 pl-9 pr-3 rounded-full text-sm border outline-none"
            style={{ color: 'var(--fg-primary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)', width: '200px' }}
            data-testid="logs-search"
          />
        </div>

        {/* Level filter pills */}
        <div className="flex items-center gap-1.5">
          {(['all', 'error', 'warn', 'info'] as const).map(level => {
            const active = levelFilter === level;
            const count = level === 'all' ? entries.length : counts[level];
            const color = level === 'error' ? 'var(--error)' : level === 'warn' ? 'var(--clay)' : level === 'info' ? 'var(--fg-tertiary)' : 'var(--fg-secondary)';
            return (
              <button
                key={level}
                onClick={() => setLevelFilter(level)}
                className="h-8 px-3 rounded-full text-sm font-medium cursor-pointer transition-all border"
                style={{
                  color: active ? 'var(--bg-white)' : color,
                  background: active ? (level === 'all' ? 'var(--fg-secondary)' : color) : 'var(--bg-primary)',
                  borderColor: active ? 'transparent' : 'var(--border-secondary)',
                }}
                data-testid={`logs-filter-${level}`}
              >
                {level === 'all' ? 'All' : level.charAt(0).toUpperCase() + level.slice(1)} ({count})
              </button>
            );
          })}
        </div>

        <div className="w-px h-6 mx-1" style={{ background: 'var(--border-secondary)' }} />

        {/* Source buttons */}
        <div className="flex items-center gap-1.5">
          {(['all', 'extension', 'apps'] as const).map(mode => {
            const active = sourceMode === mode;
            const label = mode === 'all' ? 'All' : mode === 'extension' ? 'Extension' : 'Apps';
            return (
              <button
                key={mode}
                onClick={() => { setSourceMode(mode); if (mode !== 'apps') setAppFilter('all'); }}
                className="h-8 px-3 rounded-full text-sm font-medium cursor-pointer transition-all border"
                style={{
                  color: active ? 'var(--bg-white)' : 'var(--fg-secondary)',
                  background: active ? 'var(--fg-secondary)' : 'var(--bg-primary)',
                  borderColor: active ? 'transparent' : 'var(--border-secondary)',
                }}
                data-testid={`logs-source-${mode}`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* App dropdown (only when Apps is selected) */}
        {sourceMode === 'apps' && (
          <div className="relative">
            <select
              value={appFilter}
              onChange={(e) => setAppFilter(e.target.value)}
              className="h-8 pl-3 pr-7 rounded-full text-sm font-medium cursor-pointer border appearance-none"
              style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)' }}
              data-testid="logs-app-filter"
            >
              <option value="all">All apps</option>
              {appSources.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--fg-tertiary)' }} />
          </div>
        )}

      </div>

      {/* Log entries */}
      <div
        className="flex-1 overflow-y-auto rounded-lg border min-h-0"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-tertiary)', fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)' }}
        data-testid="logs-container"
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-base" style={{ color: 'var(--fg-tertiary)', fontFamily: 'var(--font-sans, Inter, sans-serif)' }}>
            {entries.length === 0 ? 'No logs yet' : 'No logs match current filters'}
          </div>
        ) : (
          <div>
            {[...filtered].reverse().map((entry, i) => {
              const config = LEVEL_CONFIG[entry.level];
              const Icon = config.icon;
              const expanded = expandedIdx.has(i);
              const isNew = seenCutoff !== null && entry.ts > seenCutoff;

              return (
                <div key={i}>
                  <div
                    className="flex items-center gap-2 px-4 py-2 border-b transition-colors"
                    style={{ background: config.bg, borderColor: 'var(--border-tertiary)', cursor: (entry.stack || entry.message.length > 120) ? 'pointer' : undefined }}
                    onClick={() => {
                      if (!entry.stack && entry.message.length <= 120) return;
                      const next = new Set(expandedIdx);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      setExpandedIdx(next);
                    }}
                    data-testid={`log-entry-${i}`}
                  >
                    <Icon size={15} className="shrink-0" style={{ color: config.color }} />
                    <span className="text-xs shrink-0" style={{ color: 'var(--fg-tertiary)', minWidth: '110px' }}>
                      {formatTimestamp(entry.ts)}
                    </span>
                    {isNew && (
                      <span
                        className="text-xs font-semibold shrink-0 px-1.5 py-0.5 rounded uppercase tracking-wide"
                        style={{ color: 'var(--bg-white)', background: 'var(--error)' }}
                        data-testid={`log-entry-${i}-new`}
                      >
                        New
                      </span>
                    )}
                    <span
                      className="text-xs font-semibold shrink-0 px-1.5 py-0.5 rounded"
                      style={{
                        color: entry.source === 'airglow' ? 'var(--sky)' : 'var(--olive)',
                        background: entry.source === 'airglow'
                          ? 'color-mix(in srgb, var(--sky) 12%, transparent)'
                          : 'color-mix(in srgb, var(--olive) 12%, transparent)',
                        minWidth: '50px',
                        textAlign: 'center',
                      }}
                    >
                      {entry.source}
                    </span>
                    <span className="text-sm flex-1 truncate" style={{ color: 'var(--fg-primary)' }}>
                      {entry.message}
                    </span>
                    {(entry.stack || entry.message.length > 120) && (
                      <ChevronDown
                        size={18}
                        className="shrink-0 transition-transform"
                        style={{ color: 'var(--fg-tertiary)', transform: expanded ? 'rotate(180deg)' : undefined }}
                      />
                    )}
                  </div>
                  {expanded && (entry.stack || entry.message.length > 120) && (
                    <div
                      className="px-4 py-3 text-xs border-b"
                      style={{ color: 'var(--fg-primary)', borderColor: 'var(--border-tertiary)', background: 'var(--bg-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                    >
                      {entry.message}{entry.stack ? '\n\n' + entry.stack : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
