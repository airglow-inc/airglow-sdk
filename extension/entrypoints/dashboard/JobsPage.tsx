// Jobs — scheduled jobs across apps, merged from the daemon (runsOn: daemon,
// plus locally-developed cloud jobs) and the cloud tier (runsOn: cloud for
// daemonless installs). Daemon wins per (appId, jobId) so a locally-installed
// app's jobs aren't shown twice.
import { useState, useEffect, useRef } from 'react';
import {
  RefreshCw, ChevronDown, Play, CheckCircle2, XCircle, LoaderCircle,
  CalendarClock, Cloud, Minus,
} from 'lucide-react';
import { getCloudApiUrl } from '../../lib/cloud-api';
import { getStoredSession } from '../../lib/airglow-auth';

const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:3222';

interface JobRun {
  runId: string;
  appId: string;
  jobId: string;
  trigger: 'scheduled' | 'catchup' | 'manual';
  startedAt: number;
  finishedAt: number;
  status: 'ok' | 'error';
  summary?: string;
  error?: string;
  log?: string;
}

interface JobInfo {
  appId: string;
  appName: string;
  jobId: string;
  title: string;
  schedule: 'hourly' | 'daily' | 'weekly';
  runsOn: 'daemon' | 'cloud';
  running: boolean;
  lastRun: JobRun | null;
  nextDueAt: number | null;
  _source: 'local' | 'cloud';
}

async function daemonOrigin(): Promise<string> {
  const stored = await chrome.storage.local.get('__daemon_origin');
  const origin = stored['__daemon_origin'];
  return typeof origin === 'string' ? origin : DEFAULT_DAEMON_ORIGIN;
}

async function cloudHeaders(): Promise<Record<string, string> | null> {
  const session = await getStoredSession();
  if (!session?.token) return null;
  return {
    'X-Airglow-App-Id': 'airglow-extension',
    Authorization: `Bearer ${session.token}`,
    ...(session.userId ? { 'X-Airglow-User-Id': session.userId } : {}),
    ...(session.email ? { 'X-Airglow-User-Email': session.email } : {}),
  };
}

// Both sources, tolerant of either being down; daemon wins per (appId, jobId).
async function loadJobs(): Promise<{ jobs: JobInfo[]; anySourceUp: boolean }> {
  const [local, cloud] = await Promise.all([
    (async () => {
      const res = await fetch(`${await daemonOrigin()}/api/jobs`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      return (data?.jobs ?? []) as JobInfo[];
    })().catch(() => null),
    (async () => {
      const headers = await cloudHeaders();
      if (!headers) return [] as JobInfo[];
      const res = await fetch(`${await getCloudApiUrl()}/api/jobs`, { headers, signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      return (data?.jobs ?? []) as JobInfo[];
    })().catch(() => null),
  ]);
  const localJobs = (local ?? []).map((j) => ({ ...j, _source: 'local' as const }));
  const localKeys = new Set(localJobs.map((j) => `${j.appId}/${j.jobId}`));
  const cloudJobs = (cloud ?? [])
    .filter((j) => !localKeys.has(`${j.appId}/${j.jobId}`))
    .map((j) => ({ ...j, _source: 'cloud' as const }));
  return { jobs: [...localJobs, ...cloudJobs], anySourceUp: local !== null || cloud !== null };
}

async function loadRuns(job: JobInfo): Promise<JobRun[]> {
  const base = job._source === 'local' ? await daemonOrigin() : await getCloudApiUrl();
  const headers = job._source === 'cloud' ? await cloudHeaders() : null;
  if (job._source === 'cloud' && !headers) return [];
  const res = await fetch(
    `${base}/api/jobs/runs?appId=${encodeURIComponent(job.appId)}&jobId=${encodeURIComponent(job.jobId)}&limit=20`,
    { headers: headers ?? undefined, signal: AbortSignal.timeout(10000) },
  );
  const data = await res.json();
  return (data?.runs ?? []) as JobRun[];
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtIn(ts: number): string {
  const s = Math.floor((ts - Date.now()) / 1000);
  if (s <= 60) return 'due now';
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

function fmtDuration(run: JobRun): string {
  const ms = run.finishedAt - run.startedAt;
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const mon = d.toLocaleDateString('en-US', { month: 'short' });
  const time = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return `${mon} ${d.getDate()} ${time}`;
}

// The standard badge recipe (colored text on a 12% tint with a 55% border).
function Pill({ color, children, title }: { color: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="text-xs font-semibold shrink-0 px-1.5 py-0.5 rounded inline-flex items-center gap-1"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 55%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

function StatusIcon({ job }: { job: JobInfo }) {
  if (job.running) return <LoaderCircle size={17} className="shrink-0 animate-spin" style={{ color: 'var(--olive)' }} />;
  if (!job.lastRun) return <Minus size={17} className="shrink-0" style={{ color: 'var(--fg-tertiary)' }} />;
  return job.lastRun.status === 'ok'
    ? <CheckCircle2 size={17} className="shrink-0" style={{ color: 'var(--success)' }} />
    : <XCircle size={17} className="shrink-0" style={{ color: 'var(--error)' }} />;
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobInfo[] | null>(null);
  const [sourceUp, setSourceUp] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [runsByJob, setRunsByJob] = useState<Record<string, JobRun[]>>({});
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  const [runningNow, setRunningNow] = useState<Set<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  async function refresh(withRuns = true) {
    const { jobs: loaded, anySourceUp } = await loadJobs();
    setJobs(loaded);
    setSourceUp(anySourceUp);
    if (!withRuns) return;
    for (const job of loaded) {
      if (expandedRef.current.has(`${job.appId}/${job.jobId}`)) void refreshRuns(job);
    }
  }

  async function refreshRuns(job: JobInfo) {
    const runs = await loadRuns(job).catch(() => [] as JobRun[]);
    setRunsByJob((prev) => ({ ...prev, [`${job.appId}/${job.jobId}`]: runs }));
  }

  useEffect(() => {
    void refresh(false);
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleExpand(job: JobInfo) {
    const key = `${job.appId}/${job.jobId}`;
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      if (!runsByJob[key]) void refreshRuns(job);
    }
    setExpanded(next);
  }

  async function runNow(job: JobInfo) {
    const key = `${job.appId}/${job.jobId}`;
    setRunningNow((prev) => new Set(prev).add(key));
    try {
      const base = job._source === 'local' ? await daemonOrigin() : await getCloudApiUrl();
      const headers = job._source === 'cloud' ? await cloudHeaders() : null;
      await fetch(`${base}/api/jobs/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify({ appId: job.appId, jobId: job.jobId }),
        signal: AbortSignal.timeout(130_000),
      });
    } catch {
      // outcome (or failure to reach the runner) is reflected by the refresh
    } finally {
      setRunningNow((prev) => { const n = new Set(prev); n.delete(key); return n; });
      // Show the outcome: expand the job and pull its fresh run list.
      setExpanded((prev) => new Set(prev).add(key));
      void refresh(false);
      void refreshRuns(job);
    }
  }

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 64px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h2 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--fg-primary)' }}>
          Jobs
        </h2>
        <button
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-base font-medium cursor-pointer transition-all border"
          style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
          data-testid="jobs-refresh"
        >
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      {/* Job list */}
      <div
        className="flex-1 overflow-y-auto rounded-lg border min-h-0"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-tertiary)' }}
        data-testid="jobs-container"
      >
        {jobs === null ? (
          <div className="flex items-center justify-center h-48 text-base" style={{ color: 'var(--fg-tertiary)' }}>
            Loading…
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 h-56 px-8 text-center">
            <CalendarClock size={28} style={{ color: 'var(--fg-tertiary)' }} />
            <div className="text-base font-medium" style={{ color: 'var(--fg-secondary)' }}>
              {sourceUp ? 'No scheduled jobs yet' : "Couldn't reach the host or the cloud"}
            </div>
            <div className="text-sm max-w-md" style={{ color: 'var(--fg-tertiary)' }}>
              {sourceUp
                ? 'Apps declare jobs in their manifest to run on a schedule — hourly, daily, or weekly — even with no tab open.'
                : 'Start Chrome with the Airglow host installed, or sign in to see cloud jobs.'}
            </div>
          </div>
        ) : (
          jobs.map((job) => {
            const key = `${job.appId}/${job.jobId}`;
            const isExpanded = expanded.has(key);
            const isRunning = job.running || runningNow.has(key);
            const runs = runsByJob[key];
            return (
              <div key={key} className="border-b" style={{ borderColor: 'var(--border-tertiary)' }} data-testid={`job-row-${key}`}>
                {/* Job row */}
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors"
                  onClick={() => toggleExpand(job)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-secondary)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <StatusIcon job={{ ...job, running: isRunning }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-medium truncate" style={{ color: 'var(--fg-primary)' }}>
                        {job.title}
                      </span>
                      <Pill color="var(--fg-tertiary)">{job.schedule}</Pill>
                      {job.runsOn === 'cloud' && (
                        <Pill color="var(--sky)" title="Runs on Airglow cloud — works while this machine is off">
                          <Cloud size={11} /> cloud
                        </Pill>
                      )}
                    </div>
                    <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--fg-tertiary)' }}>
                      {job.appName}
                      {job.lastRun && (
                        <>
                          {' · '}
                          {job.lastRun.status === 'ok' ? 'ran' : (
                            <span style={{ color: 'var(--error)', fontWeight: 600 }}>failed</span>
                          )}{' '}
                          {fmtAgo(job.lastRun.startedAt)}
                        </>
                      )}
                      {!job.lastRun && !isRunning && ' · never run'}
                      {isRunning && ' · running now'}
                    </div>
                  </div>
                  {job.nextDueAt !== null && !isRunning && (
                    <span className="text-sm shrink-0 tabular-nums" style={{ color: 'var(--fg-tertiary)' }}>
                      {fmtIn(job.nextDueAt)}
                    </span>
                  )}
                  <button
                    disabled={isRunning}
                    onClick={(e) => { e.stopPropagation(); void runNow(job); }}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-sm font-medium transition-all border shrink-0"
                    style={{
                      color: isRunning ? 'var(--fg-tertiary)' : 'var(--fg-secondary)',
                      borderColor: 'var(--border-secondary)',
                      background: 'var(--bg-primary)',
                      cursor: isRunning ? 'default' : 'pointer',
                      opacity: isRunning ? 0.6 : 1,
                    }}
                    onMouseEnter={(e) => { if (!isRunning) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-primary)'; }}
                    data-testid={`job-run-now-${key}`}
                  >
                    {isRunning ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
                    {isRunning ? 'Running…' : 'Run now'}
                  </button>
                  <ChevronDown
                    size={18}
                    className="shrink-0 transition-transform"
                    style={{ color: 'var(--fg-tertiary)', transform: isExpanded ? 'rotate(180deg)' : undefined }}
                  />
                </div>

                {/* Run history */}
                {isExpanded && (
                  <div className="border-t" style={{ borderColor: 'var(--border-tertiary)', background: 'var(--bg-secondary)' }}>
                    {runs === undefined ? (
                      <div className="px-12 py-3 text-sm" style={{ color: 'var(--fg-tertiary)' }}>Loading runs…</div>
                    ) : runs.length === 0 ? (
                      <div className="px-12 py-3 text-sm" style={{ color: 'var(--fg-tertiary)' }}>No runs yet.</div>
                    ) : (
                      runs.map((run) => {
                        const runKey = `${key}/${run.runId}`;
                        const hasDetail = Boolean(run.log || run.error);
                        const isOpen = openRuns.has(runKey);
                        return (
                          <div key={run.runId}>
                            <div
                              className="flex items-center gap-2.5 pl-12 pr-4 py-2 text-sm"
                              style={{ cursor: hasDetail ? 'pointer' : undefined }}
                              onClick={() => {
                                if (!hasDetail) return;
                                setOpenRuns((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(runKey)) next.delete(runKey); else next.add(runKey);
                                  return next;
                                });
                              }}
                              data-testid={`job-run-${run.runId}`}
                            >
                              {run.status === 'ok'
                                ? <CheckCircle2 size={14} className="shrink-0" style={{ color: 'var(--success)' }} />
                                : <XCircle size={14} className="shrink-0" style={{ color: 'var(--error)' }} />}
                              <span className="shrink-0 text-xs tabular-nums" title={fmtWhen(run.startedAt)} style={{ color: 'var(--fg-tertiary)', minWidth: '64px' }}>
                                {fmtAgo(run.startedAt)}
                              </span>
                              <span className="shrink-0 text-xs tabular-nums" style={{ color: 'var(--fg-tertiary)', minWidth: '38px' }}>
                                {fmtDuration(run)}
                              </span>
                              {run.trigger !== 'scheduled' && (
                                <Pill color={run.trigger === 'manual' ? 'var(--olive)' : 'var(--clay)'}>
                                  {run.trigger === 'manual' ? 'manual' : 'catch-up'}
                                </Pill>
                              )}
                              <span className="flex-1 truncate" style={{ color: run.status === 'ok' ? 'var(--fg-secondary)' : 'var(--error)' }}>
                                {run.status === 'ok' ? (run.summary || 'Completed') : (run.error || 'Failed')}
                              </span>
                              {hasDetail && (
                                <ChevronDown
                                  size={15}
                                  className="shrink-0 transition-transform"
                                  style={{ color: 'var(--fg-tertiary)', transform: isOpen ? 'rotate(180deg)' : undefined }}
                                />
                              )}
                            </div>
                            {isOpen && hasDetail && (
                              <pre
                                className="mx-12 mb-2 px-3 py-2 text-xs rounded border overflow-auto"
                                style={{
                                  color: 'var(--fg-primary)', background: 'var(--bg-white)',
                                  borderColor: 'var(--border-tertiary)', whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word', maxHeight: '240px',
                                  fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
                                }}
                              >
                                {[run.error && `Error: ${run.error}`, run.log].filter(Boolean).join('\n\n')}
                              </pre>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
