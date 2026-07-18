// Job scheduler — runs manifest-declared jobs (`jobs: [...]`) on a timer.
//
// Apps declare jobs in manifest.json:
//   "jobs": [{ "id": "send-daily-email", "title": "Send daily email",
//              "schedule": "daily", "entry": "jobs/send-email.ts",
//              "runsOn": "daemon", "config": { ... } }]
// The entry file default-exports `async (config) => summary`; it runs through
// the same fresh-subprocess path as server functions (global `airglow` server
// SDK available, console captured). A throw marks the run failed.
//
// Scheduling is interval-since-last-run, not wall-clock cron: a job is due
// when `now - lastRun.startedAt >= interval`. The 60s tick plus a wall-clock
// comparison gives catch-up after sleep for free — a laptop waking past the
// due time runs the job on the next tick (trigger 'catchup' when it was
// missed by more than 10 minutes). A job never seen before runs on the next
// tick, so a fresh install gives immediate feedback.
//
// Run records are JSONL at state/jobs/<appId>.jsonl (same pattern as agent
// sessions), one line per run, compacted to the newest runs when the file
// grows. `runsOn: "cloud"` jobs are listed (and manually runnable, for local
// development) but never scheduled here — the cloud cron owns them.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AppServer, AppManifest } from './apps';

export type JobSchedule = 'hourly' | 'daily' | 'weekly';
export type JobTrigger = 'scheduled' | 'catchup' | 'manual';

export interface JobDef {
  appId: string;
  appName: string;
  jobId: string;
  title: string;
  schedule: JobSchedule;
  entry: string;
  runsOn: 'daemon' | 'cloud';
  config?: unknown;
}

export interface JobRun {
  runId: string;
  appId: string;
  jobId: string;
  trigger: JobTrigger;
  startedAt: number;
  finishedAt: number;
  status: 'ok' | 'error';
  summary?: string;
  error?: string;
  log?: string;
}

const INTERVALS: Record<JobSchedule, number> = {
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

const TICK_MS = 60_000;
const CATCHUP_SLACK_MS = 10 * 60_000;
const LOG_CAP = 8_192;      // captured console output kept per run
const SUMMARY_CAP = 2_000;
const COMPACT_AT = 120;     // lines; rewrite keeping the newest KEEP_RUNS
const KEEP_RUNS = 60;

const JOB_ID = /^[\w-]+$/;

// Manifest `jobs` → validated defs. Malformed entries are skipped with a
// warning rather than failing the app (manifests are untyped by design).
export function collectJobs(manifests: AppManifest[]): JobDef[] {
  const out: JobDef[] = [];
  for (const m of manifests) {
    if (!m.id || !Array.isArray(m.jobs)) continue;
    for (const j of m.jobs) {
      if (!j || typeof j !== 'object') continue;
      const jobId = typeof j.id === 'string' ? j.id : '';
      const entry = typeof j.entry === 'string' ? j.entry : '';
      const schedule = j.schedule as JobSchedule;
      if (!JOB_ID.test(jobId) || !entry || entry.includes('..') || !(schedule in INTERVALS)) {
        console.error(`[jobs/${m.id}] skipping malformed job ${JSON.stringify(j?.id ?? j)} — need { id, schedule: hourly|daily|weekly, entry }`);
        continue;
      }
      out.push({
        appId: m.id,
        appName: m.name || m.id,
        jobId,
        title: typeof j.title === 'string' && j.title ? j.title : jobId,
        schedule,
        entry,
        runsOn: j.runsOn === 'cloud' ? 'cloud' : 'daemon',
        config: j.config,
      });
    }
  }
  return out;
}

export class JobScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  // key `${appId}/${jobId}` → most recent run. Hydrated per app from the
  // JSONL file on first access; appends keep it current after that.
  private lastRuns = new Map<string, JobRun>();
  private hydrated = new Set<string>();

  constructor(private readonly workspace: string, private readonly apps: AppServer) {}

  private runsDir(): string {
    return join(this.workspace, 'state', 'jobs');
  }
  private runsPath(appId: string): string {
    return join(this.runsDir(), `${appId}.jsonl`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, TICK_MS);
    (this.timer as any).unref?.();
    // First tick shortly after startup: catch up anything missed while the
    // daemon was down without racing workspace init.
    const kickoff = setTimeout(() => { this.tick().catch(() => {}); }, 5_000);
    (kickoff as any).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const manifests = await this.apps.scanManifests();
    for (const def of collectJobs(manifests)) {
      if (def.runsOn !== 'daemon') continue;
      const key = `${def.appId}/${def.jobId}`;
      if (this.running.has(key)) continue;
      const last = this.lastRun(def.appId, def.jobId);
      const interval = INTERVALS[def.schedule];
      if (last && Date.now() - last.startedAt < interval) continue;
      const overdueBy = last ? Date.now() - (last.startedAt + interval) : 0;
      const trigger: JobTrigger = overdueBy > CATCHUP_SLACK_MS ? 'catchup' : 'scheduled';
      // Sequential on purpose: jobs are rare and a burst of due jobs (first
      // tick after a long sleep) shouldn't fork-bomb the box.
      await this.execute(def, trigger).catch(() => {});
    }
  }

  async runNow(appId: string, jobId: string): Promise<{ ok: true; run: JobRun } | { ok: false; error: string }> {
    const manifests = await this.apps.scanManifests();
    const def = collectJobs(manifests).find((d) => d.appId === appId && d.jobId === jobId);
    if (!def) return { ok: false, error: `job '${appId}/${jobId}' not found` };
    if (this.running.has(`${appId}/${jobId}`)) return { ok: false, error: 'job is already running' };
    return { ok: true, run: await this.execute(def, 'manual') };
  }

  private async execute(def: JobDef, trigger: JobTrigger): Promise<JobRun> {
    const key = `${def.appId}/${def.jobId}`;
    this.running.add(key);
    const startedAt = Date.now();
    console.log(`[jobs/${def.appId}/${def.jobId}] run started (${trigger})`);
    try {
      const res = await this.apps.execServerEntry(def.appId, def.entry, def.config ?? {});
      const run: JobRun = {
        runId: `${startedAt.toString(36)}-${randomBytes(3).toString('hex')}`,
        appId: def.appId,
        jobId: def.jobId,
        trigger,
        startedAt,
        finishedAt: Date.now(),
        status: res.ok ? 'ok' : 'error',
        ...(res.ok ? { summary: summarize(res.result) } : { error: res.error ?? 'job failed' }),
        ...(res.log ? { log: res.log.slice(-LOG_CAP) } : {}),
      };
      this.append(run);
      console.log(`[jobs/${def.appId}/${def.jobId}] run ${run.status}${run.error ? ` — ${run.error}` : ''} (${run.finishedAt - run.startedAt}ms)`);
      return run;
    } finally {
      this.running.delete(key);
    }
  }

  // Jobs across all workspace apps, with last-run status and (for daemon
  // jobs) the next due time. Cloud jobs appear so a locally-developed app's
  // cloud job is visible/testable; the dashboard merges the cloud's own list.
  async listJobs(): Promise<Array<JobDef & { running: boolean; lastRun: JobRun | null; nextDueAt: number | null }>> {
    const manifests = await this.apps.scanManifests();
    return collectJobs(manifests).map((def) => {
      const last = this.lastRun(def.appId, def.jobId);
      const { config, ...pub } = def;
      return {
        ...pub,
        running: this.running.has(`${def.appId}/${def.jobId}`),
        lastRun: last ? { ...last, log: undefined } : null,
        nextDueAt: def.runsOn === 'daemon'
          ? (last ? last.startedAt + INTERVALS[def.schedule] : Date.now())
          : null,
      };
    });
  }

  listRuns(appId?: string, jobId?: string, limit = 50): JobRun[] {
    let files: string[] = [];
    try { files = readdirSync(this.runsDir()).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
    const runs: JobRun[] = [];
    for (const f of files) {
      const app = f.slice(0, -'.jsonl'.length);
      if (appId && app !== appId) continue;
      runs.push(...this.readRuns(app));
    }
    return runs
      .filter((r) => !jobId || r.jobId === jobId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  private lastRun(appId: string, jobId: string): JobRun | null {
    if (!this.hydrated.has(appId)) {
      this.hydrated.add(appId);
      for (const run of this.readRuns(appId)) {
        const k = `${run.appId}/${run.jobId}`;
        const prev = this.lastRuns.get(k);
        if (!prev || run.startedAt > prev.startedAt) this.lastRuns.set(k, run);
      }
    }
    return this.lastRuns.get(`${appId}/${jobId}`) ?? null;
  }

  private readRuns(appId: string): JobRun[] {
    let content: string;
    try { content = readFileSync(this.runsPath(appId), 'utf8'); } catch { return []; }
    const runs: JobRun[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { runs.push(JSON.parse(line)); } catch {}
    }
    return runs;
  }

  private append(run: JobRun): void {
    this.lastRuns.set(`${run.appId}/${run.jobId}`, run);
    this.hydrated.add(run.appId);
    try {
      mkdirSync(this.runsDir(), { recursive: true });
      const path = this.runsPath(run.appId);
      appendFileSync(path, JSON.stringify(run) + '\n');
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
      if (lines.length > COMPACT_AT) {
        writeFileSync(path, lines.slice(-KEEP_RUNS).join('\n') + '\n');
      }
    } catch (e: any) {
      console.error(`[jobs/${run.appId}] failed to persist run record: ${e?.message ?? e}`);
    }
  }
}

function summarize(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'string') return result.slice(0, SUMMARY_CAP);
  try { return JSON.stringify(result).slice(0, SUMMARY_CAP); } catch { return String(result).slice(0, SUMMARY_CAP); }
}
