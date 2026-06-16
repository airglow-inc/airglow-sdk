/**
 * Centralized logger — stores log entries in chrome.storage.local as a ring buffer.
 * Used by background, message handler, and SDK relay. Dashboard reads via airglow:logs:get.
 */

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;   // 'airglow' for extension-level, appId for app-level
  message: string;
  stack?: string;
}

const LOGS_KEY = '__airglow_logs';
const MAX_PER_LEVEL = 1000;

function trimPerLevel(entries: LogEntry[]): LogEntry[] {
  const counts = { info: 0, warn: 0, error: 0 };
  for (const e of entries) counts[e.level]++;
  const overflow = {
    info: Math.max(0, counts.info - MAX_PER_LEVEL),
    warn: Math.max(0, counts.warn - MAX_PER_LEVEL),
    error: Math.max(0, counts.error - MAX_PER_LEVEL),
  };
  if (overflow.info === 0 && overflow.warn === 0 && overflow.error === 0) return entries;
  const remaining = { ...overflow };
  const kept: LogEntry[] = [];
  for (const e of entries) {
    if (remaining[e.level] > 0) {
      remaining[e.level]--;
      continue;
    }
    kept.push(e);
  }
  return kept;
}

// In-memory buffer for batching writes
let buffer: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY = 300; // ms — batch rapid-fire logs into one storage write

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY);
}

async function flush() {
  flushTimer = null;
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];

  try {
    const result = await chrome.storage.local.get(LOGS_KEY);
    const existing: LogEntry[] = Array.isArray(result[LOGS_KEY]) ? result[LOGS_KEY] : [];
    const merged = trimPerLevel(existing.concat(batch));
    await chrome.storage.local.set({ [LOGS_KEY]: merged });
  } catch (e) {
    // Storage write failed — re-queue entries so they aren't lost
    buffer = batch.concat(buffer);
  }
}

function write(level: LogEntry['level'], source: string, message: string, stack?: string) {
  const entry: LogEntry = { ts: Date.now(), level, source, message };
  if (stack) entry.stack = stack;

  buffer.push(entry);
  scheduleFlush();

  // Also emit to console for CDP log-watcher visibility
  const prefix = `[${source}]`;
  if (level === 'error') {
    console.error(prefix, message, stack || '');
  } else if (level === 'warn') {
    console.warn(prefix, message);
  } else {
    console.log(prefix, message);
  }
}

export const logger = {
  info: (source: string, message: string) => write('info', source, message),
  warn: (source: string, message: string) => write('warn', source, message),
  error: (source: string, message: string, stack?: string) => write('error', source, message, stack),

  /** Read all stored logs. */
  async getAll(): Promise<LogEntry[]> {
    const result = await chrome.storage.local.get(LOGS_KEY);
    return Array.isArray(result[LOGS_KEY]) ? result[LOGS_KEY] : [];
  },

  /** Clear all stored logs. */
  async clear(): Promise<void> {
    buffer = [];
    await chrome.storage.local.remove(LOGS_KEY);
  },
};
