// Jobs — scheduled jobs across apps, merged from the daemon (runsOn: daemon,
// plus locally-developed cloud jobs) and the cloud tier (runsOn: cloud for
// daemonless installs). Daemon wins per (appId, jobId) so a locally-installed
// app's jobs aren't shown twice.
//
// Two views: Scheduled (recurring jobs + pending one-shot tasks, merged and
// sorted by next fire time) and History (flat run list across all jobs,
// newest first — the per-job history also stays reachable by expanding a
// recurring row in Scheduled).
import { useState, useEffect, useRef } from 'react';
import {
  RefreshCw, ChevronDown, Play, CheckCircle2, XCircle, LoaderCircle,
  CalendarClock, Cloud, Minus, Clock, X, Repeat,
} from 'lucide-react';
import { getCloudApiUrl } from '../../lib/cloud-api';
import { getStoredSession } from '../../lib/airglow-auth';

const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:3222';

interface JobRun {
  runId: string;
  appId: string;
  jobId: string;
  trigger: 'scheduled' | 'catchup' | 'manual' | 'once';
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
  schedule: 'hourly' | 'daily' | 'weekly' | null;
  runsOn: 'daemon' | 'cloud';
  running: boolean;
  lastRun: JobRun | null;
  nextDueAt: number | null;
  _source: 'local' | 'cloud';
}

interface JobTask {
  taskId: string;
  appId: string;
  jobId: string;
  runAt: number;
  createdAt: number;
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

interface JobsData {
  jobs: JobInfo[];
  tasks: JobTask[];
  anySourceUp: boolean;
}

// Both sources, tolerant of either being down; daemon wins per (appId, jobId).
async function loadJobs(): Promise<JobsData> {
  const [local, cloud] = await Promise.all([
    (async () => {
      const res = await fetch(`${await daemonOrigin()}/api/jobs`, { signal: AbortSignal.timeout(5000) });
      return await res.json();
    })().catch(() => null),
    (async () => {
      const headers = await cloudHeaders();
      if (!headers) return { jobs: [], tasks: [] };
      const res = await fetch(`${await getCloudApiUrl()}/api/jobs`, { headers, signal: AbortSignal.timeout(10000) });
      return await res.json();
    })().catch(() => null),
  ]);
  const tag = (data: any, source: 'local' | 'cloud') => ({
    jobs: ((data?.jobs ?? []) as JobInfo[]).map((j) => ({ ...j, _source: source })),
    tasks: ((data?.tasks ?? []) as JobTask[]).map((t) => ({ ...t, _source: source })),
  });
  const l = tag(local, 'local');
  const c = tag(cloud, 'cloud');
  const localJobKeys = new Set(l.jobs.map((j) => `${j.appId}/${j.jobId}`));
  return {
    jobs: [...l.jobs, ...c.jobs.filter((j) => !localJobKeys.has(`${j.appId}/${j.jobId}`))],
    tasks: [...l.tasks, ...c.tasks],
    anySourceUp: local !== null || cloud !== null,
  };
}

async function loadRunsFrom(source: 'local' | 'cloud', params: string): Promise<JobRun[] | null> {
  try {
    const base = source === 'local' ? await daemonOrigin() : await getCloudApiUrl();
    const headers = source === 'cloud' ? await cloudHeaders() : null;
    if (source === 'cloud' && !headers) return [];
    const res = await fetch(`${base}/api/jobs/runs?${params}`, {
      headers: headers ?? undefined,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return (data?.runs ?? []) as JobRun[];
  } catch {
    return null;
  }
}

async function loadJobRuns(job: JobInfo): Promise<JobRun[]> {
  const runs = await loadRunsFrom(job._source, `appId=${encodeURIComponent(job.appId)}&jobId=${encodeURIComponent(job.jobId)}&limit=20`);
  return runs ?? [];
}

async function loadAllRuns(): Promise<JobRun[]> {
  const [local, cloud] = await Promise.all([
    loadRunsFrom('local', 'limit=100'),
    loadRunsFrom('cloud', 'limit=100'),
  ]);
  return [...(local ?? []), ...(cloud ?? [])].sort((a, b) => b.startedAt - a.startedAt);
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

const TRIGGER_PILL: Partial<Record<JobRun['trigger'], { color: string; label: string }>> = {
  manual: { color: 'var(--olive)', label: 'manual' },
  catchup: { color: 'var(--clay)', label: 'catch-up' },
  once: { color: 'var(--sky)', label: 'one-time' },
};

function StatusIcon({ job }: { job: JobInfo }) {
  if (job.running) return <LoaderCircle size={17} className="shrink-0 animate-spin" style={{ color: 'var(--olive)' }} />;
  if (!job.lastRun) return <Minus size={17} className="shrink-0" style={{ color: 'var(--fg-tertiary)' }} />;
  return job.lastRun.status === 'ok'
    ? <CheckCircle2 size={17} className="shrink-0" style={{ color: 'var(--success)' }} />
    : <XCircle size={17} className="shrink-0" style={{ color: 'var(--error)' }} />;
}

// One flat history row: status, when, app · job, trigger, duration, outcome.
function RunRow({ run, label, indent, open, onToggle }: {
  run: JobRun; label?: string; indent: boolean; open: boolean; onToggle: () => void;
}) {
  const hasDetail = Boolean(run.log || run.error);
  const pill = TRIGGER_PILL[run.trigger];
  return (
    <div>
      <div
        className={`flex items-center gap-2.5 ${indent ? 'pl-12' : 'pl-4'} pr-4 py-2 text-sm`}
        style={{ cursor: hasDetail ? 'pointer' : undefined }}
        onClick={() => { if (hasDetail) onToggle(); }}
        data-testid={`job-run-${run.runId}`}
      >
        {run.status === 'ok'
          ? <CheckCircle2 size={14} className="shrink-0" style={{ color: 'var(--success)' }} />
          : <XCircle size={14} className="shrink-0" style={{ color: 'var(--error)' }} />}
        <span className="shrink-0 text-xs tabular-nums" title={fmtWhen(run.startedAt)} style={{ color: 'var(--fg-tertiary)', minWidth: '64px' }}>
          {fmtAgo(run.startedAt)}
        </span>
        {label && (
          <span className="shrink-0 text-xs truncate" style={{ color: 'var(--fg-secondary)', maxWidth: '220px' }}>
            {label}
          </span>
        )}
        <span className="shrink-0 text-xs tabular-nums" style={{ color: 'var(--fg-tertiary)', minWidth: '38px' }}>
          {fmtDuration(run)}
        </span>
        {pill && <Pill color={pill.color}>{pill.label}</Pill>}
        <span className="flex-1 truncate" style={{ color: run.status === 'ok' ? 'var(--fg-secondary)' : 'var(--error)' }}>
          {run.status === 'ok' ? (run.summary || 'Completed') : (run.error || 'Failed')}
        </span>
        {hasDetail && (
          <ChevronDown
            size={15}
            className="shrink-0 transition-transform"
            style={{ color: 'var(--fg-tertiary)', transform: open ? 'rotate(180deg)' : undefined }}
          />
        )}
      </div>
      {open && hasDetail && (
        <pre
          className={`${indent ? 'mx-12' : 'mx-4'} mb-2 px-3 py-2 text-xs rounded border overflow-auto`}
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
}

export default function JobsPage() {
  const [tab, setTab] = useState<'scheduled' | 'history'>('scheduled');
  const [data, setData] = useState<JobsData | null>(null);
  const [history, setHistory] = useState<JobRun[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [runsByJob, setRunsByJob] = useState<Record<string, JobRun[]>>({});
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  const [runningNow, setRunningNow] = useState<Set<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  async function refresh() {
    const [loaded, runs] = await Promise.all([loadJobs(), loadAllRuns()]);
    setData(loaded);
    setHistory(runs);
    for (const job of loaded.jobs) {
      if (expandedRef.current.has(`${job.appId}/${job.jobId}`)) void refreshJobRuns(job);
    }
  }

  async function refreshJobRuns(job: JobInfo) {
    const runs = await loadJobRuns(job);
    setRunsByJob((prev) => ({ ...prev, [`${job.appId}/${job.jobId}`]: runs }));
  }

  useEffect(() => {
    void refresh();
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
      if (!runsByJob[key]) void refreshJobRuns(job);
    }
    setExpanded(next);
  }

  function toggleRun(runKey: string) {
    setOpenRuns((prev) => {
      const next = new Set(prev);
      if (next.has(runKey)) next.delete(runKey); else next.add(runKey);
      return next;
    });
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
      void refresh();
      void refreshJobRuns(job);
    }
  }

  async function cancelTask(task: JobTask) {
    try {
      const base = task._source === 'local' ? await daemonOrigin() : await getCloudApiUrl();
      const headers = task._source === 'cloud' ? await cloudHeaders() : null;
      await fetch(`${base}/api/jobs/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify({ appId: task.appId, taskId: task.taskId }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {}
    void refresh();
  }

  const jobs = data?.jobs ?? [];
  const tasks = data?.tasks ?? [];
  const jobByKey = new Map(jobs.map((j) => [`${j.appId}/${j.jobId}`, j]));

  // One time-ordered list: pending one-shots + recurring jobs by next fire
  // time; on-demand jobs (no schedule, no pending task) sink to the bottom.
  const scheduledItems: Array<{ kind: 'job'; job: JobInfo; sort: number } | { kind: 'task'; task: JobTask; sort: number }> = [
    ...tasks.map((task) => ({ kind: 'task' as const, task, sort: task.runAt })),
    ...jobs.map((job) => ({ kind: 'job' as const, job, sort: job.nextDueAt ?? Number.MAX_SAFE_INTEGER })),
  ].sort((a, b) => a.sort - b.sort);

  const failedRuns = (history ?? []).filter((r) => r.status === 'error').length;

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

      {/* Tabs */}
      <div className="flex items-center gap-1.5 mb-3 shrink-0">
        {([
          { id: 'scheduled' as const, label: `Scheduled (${scheduledItems.length})` },
          { id: 'history' as const, label: `History (${history?.length ?? 0})` },
        ]).map(({ id, label }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              className="h-8 px-3 rounded-full text-sm font-medium cursor-pointer transition-all border"
              style={{
                color: active ? 'var(--bg-white)' : 'var(--fg-secondary)',
                background: active ? 'var(--fg-secondary)' : 'var(--bg-primary)',
                borderColor: active ? 'transparent' : 'var(--border-secondary)',
              }}
              data-testid={`jobs-tab-${id}`}
            >
              {label}
            </button>
          );
        })}
        {tab === 'history' && failedRuns > 0 && (
          <span className="text-sm ml-1" style={{ color: 'var(--fg-tertiary)' }}>
            {failedRuns} failed
          </span>
        )}
      </div>

      {/* Content */}
      <div
        className="flex-1 overflow-y-auto rounded-lg border min-h-0"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-tertiary)' }}
        data-testid="jobs-container"
      >
        {data === null ? (
          <div className="flex items-center justify-center h-48 text-base" style={{ color: 'var(--fg-tertiary)' }}>
            Loading…
          </div>
        ) : tab === 'history' ? (
          (history ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 h-56 px-8 text-center">
              <Clock size={28} style={{ color: 'var(--fg-tertiary)' }} />
              <div className="text-base font-medium" style={{ color: 'var(--fg-secondary)' }}>No runs yet</div>
              <div className="text-sm max-w-md" style={{ color: 'var(--fg-tertiary)' }}>
                Every job run — scheduled, one-time, or manual — shows up here with its output.
              </div>
            </div>
          ) : (
            (history ?? []).map((run) => {
              const job = jobByKey.get(`${run.appId}/${run.jobId}`);
              const runKey = `history/${run.runId}`;
              return (
                <div key={runKey} className="border-b" style={{ borderColor: 'var(--border-tertiary)' }}>
                  <RunRow
                    run={run}
                    label={job ? `${job.appName} · ${job.title}` : `${run.appId} · ${run.jobId}`}
                    indent={false}
                    open={openRuns.has(runKey)}
                    onToggle={() => toggleRun(runKey)}
                  />
                </div>
              );
            })
          )
        ) : scheduledItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 h-56 px-8 text-center">
            <CalendarClock size={28} style={{ color: 'var(--fg-tertiary)' }} />
            <div className="text-base font-medium" style={{ color: 'var(--fg-secondary)' }}>
              {data.anySourceUp ? 'Nothing scheduled yet' : "Couldn't reach the host or the cloud"}
            </div>
            <div className="text-sm max-w-md" style={{ color: 'var(--fg-tertiary)' }}>
              {data.anySourceUp
                ? 'Apps declare recurring jobs in their manifest, or queue one-time runs from code — both show up here.'
                : 'Start Chrome with the Airglow host installed, or sign in to see cloud jobs.'}
            </div>
          </div>
        ) : (
          scheduledItems.map((item) => {
            if (item.kind === 'task') {
              const { task } = item;
              const job = jobByKey.get(`${task.appId}/${task.jobId}`);
              return (
                <div
                  key={task.taskId}
                  className="flex items-center gap-3 px-4 py-3 border-b"
                  style={{ borderColor: 'var(--border-tertiary)' }}
                  data-testid={`job-task-${task.taskId}`}
                >
                  <Clock size={17} className="shrink-0" style={{ color: 'var(--sky)' }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-medium truncate" style={{ color: 'var(--fg-primary)' }}>
                        {job?.title ?? task.jobId}
                      </span>
                      <Pill color="var(--sky)">one-time</Pill>
                      {task._source === 'cloud' && (
                        <Pill color="var(--sky)" title="Runs on Airglow cloud — works while this machine is off">
                          <Cloud size={11} /> cloud
                        </Pill>
                      )}
                      {/* A cloud job's task that fell back to local storage
                          (signed out / app unpublished / cloud down) runs on
                          this machine — surface the mismatch. */}
                      {task._source === 'local' && job?.runsOn === 'cloud' && (
                        <Pill color="var(--clay)" title="The cloud couldn't take this task when it was scheduled — it runs on this machine, only while it's awake">
                          this device
                        </Pill>
                      )}
                    </div>
                    <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--fg-tertiary)' }}>
                      {job?.appName ?? task.appId} · {fmtWhen(task.runAt)}
                    </div>
                  </div>
                  <span className="text-sm shrink-0 tabular-nums" style={{ color: 'var(--fg-secondary)' }}>
                    {fmtIn(task.runAt)}
                  </span>
                  <button
                    onClick={() => void cancelTask(task)}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-sm font-medium cursor-pointer transition-all border shrink-0"
                    style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)' }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = 'var(--error)';
                      e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--error) 55%, transparent)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'var(--fg-secondary)';
                      e.currentTarget.style.borderColor = 'var(--border-secondary)';
                    }}
                    data-testid={`job-task-cancel-${task.taskId}`}
                  >
                    <X size={14} />
                    Cancel
                  </button>
                  {/* spacer aligns with job rows' chevron column */}
                  <span style={{ width: 18 }} className="shrink-0" />
                </div>
              );
            }

            const { job } = item;
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
                      {job.schedule
                        ? <Pill color="var(--fg-tertiary)"><Repeat size={11} /> {job.schedule}</Pill>
                        : <Pill color="var(--fg-tertiary)" title="No recurring schedule — runs when the app queues it or via Run now">on demand</Pill>}
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

                {/* Per-job run history */}
                {isExpanded && (
                  <div className="border-t" style={{ borderColor: 'var(--border-tertiary)', background: 'var(--bg-secondary)' }}>
                    {runs === undefined ? (
                      <div className="px-12 py-3 text-sm" style={{ color: 'var(--fg-tertiary)' }}>Loading runs…</div>
                    ) : runs.length === 0 ? (
                      <div className="px-12 py-3 text-sm" style={{ color: 'var(--fg-tertiary)' }}>No runs yet.</div>
                    ) : (
                      runs.map((run) => {
                        const runKey = `${key}/${run.runId}`;
                        return (
                          <RunRow
                            key={run.runId}
                            run={run}
                            indent
                            open={openRuns.has(runKey)}
                            onToggle={() => toggleRun(runKey)}
                          />
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
