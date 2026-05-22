import { useState, useEffect, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Clock, Shield, Youtube, Instagram, Twitter, Linkedin, Mail, MessageCircle } from 'lucide-react';
declare const airglow: any;

const SCHEDULE_KEY = 'focus_hider_schedule';
const SITES_KEY = 'focus_hider_sites';

interface Schedule {
  allowStart: number;
  allowEnd: number;
  enabled: boolean;
}

type SiteFlags = Record<string, boolean>;

const DEFAULT_SCHEDULE: Schedule = { allowStart: 2, allowEnd: 11, enabled: true };

const SITES = [
  { key: 'youtube', name: 'YouTube', desc: 'Hides feed, shorts, suggestions', icon: Youtube },
  { key: 'instagram', name: 'Instagram', desc: 'Hides feed, stories, reels', icon: Instagram },
  { key: 'x', name: 'X (Twitter)', desc: 'Hides timeline, sidebar, trends', icon: Twitter },
  { key: 'linkedin', name: 'LinkedIn', desc: 'Hides feed, sidebar, notifications', icon: Linkedin },
  { key: 'messaging', name: 'WhatsApp & Telegram', desc: 'Hides chat list, search only', icon: MessageCircle },
  { key: 'gmail', name: 'Gmail', desc: 'Time-based blocking with schedule', icon: Mail },
] as const;

const DEFAULT_SITES: SiteFlags = Object.fromEntries(SITES.map(s => [s.key, true]));

function formatHour(h: number): string {
  const period = h >= 12 ? 'PM' : 'AM';
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${display}:00 ${period}`;
}

function getBlockedHours(start: number, end: number): number {
  if (start < end) return 24 - (end - start);
  return start - end;
}

function Toggle({ on, onToggle, testId }: { on: boolean; onToggle: () => void; testId?: string }) {
  return (
    <button
      onClick={onToggle}
      className="relative w-11 h-6 rounded-full cursor-pointer transition-colors shrink-0"
      style={{ background: on ? 'var(--clay)' : 'var(--bg-tertiary)' }}
      data-testid={testId}
    >
      <div
        className="absolute top-0.5 w-5 h-5 rounded-full transition-transform"
        style={{
          background: 'var(--bg-white)',
          transform: on ? 'translateX(22px)' : 'translateX(2px)',
        }}
      />
    </button>
  );
}

export default function App() {
  const [schedule, setSchedule] = useState<Schedule>(DEFAULT_SCHEDULE);
  const [sites, setSites] = useState<SiteFlags>(DEFAULT_SITES);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    Promise.all([
      airglow.storage.get(SCHEDULE_KEY),
      airglow.storage.get(SITES_KEY),
    ]).then(([schedVal, sitesVal]: [string | undefined, string | undefined]) => {
      if (schedVal) {
        try { setSchedule({ ...DEFAULT_SCHEDULE, ...JSON.parse(schedVal) }); } catch {}
      }
      if (sitesVal) {
        try { setSites({ ...DEFAULT_SITES, ...JSON.parse(sitesVal) }); } catch {}
      }
      setMounted(true);
    });
  }, []);

  function saveSchedule(updates: Partial<Schedule>) {
    const next = { ...schedule, ...updates };
    setSchedule(next);
    airglow.storage.set(SCHEDULE_KEY, JSON.stringify(next));
  }

  function toggleSite(key: string) {
    const next = { ...sites, [key]: !sites[key] };
    setSites(next);
    airglow.storage.set(SITES_KEY, JSON.stringify(next));
  }

  if (!mounted) return null;

  const blockedHours = getBlockedHours(schedule.allowStart, schedule.allowEnd);
  const now = new Date().getHours();
  const isCurrentlyBlocked = schedule.enabled && sites.gmail && (() => {
    const { allowStart, allowEnd } = schedule;
    if (allowStart < allowEnd) return !(now >= allowStart && now < allowEnd);
    return !(now >= allowStart || now < allowEnd);
  })();

  return (
    <div className="min-h-screen p-8 font-sans" style={{ background: 'var(--bg-primary)', color: 'var(--fg-primary)' }}>
      <div className="max-w-[600px] mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <Shield size={24} style={{ color: 'var(--clay)' }} />
          <h1 className="text-2xl font-semibold" style={{ letterSpacing: '-0.02em' }}>Focus Hider</h1>
        </div>

        {/* Sites list */}
        <div className="rounded-md" style={{ background: 'var(--bg-white)', boxShadow: 'var(--shadow-card)' }}>
          {SITES.map((site, i) => {
            const Icon = site.icon;
            const enabled = sites[site.key] ?? true;
            const isLast = i === SITES.length - 1;
            return (
              <div key={site.key}>
                <div
                  className="flex items-center gap-3 px-5 py-4"
                  style={{ borderBottom: isLast && !(site.key === 'gmail' && enabled) ? 'none' : '1px solid var(--border-tertiary)' }}
                >
                  <Icon size={20} style={{ color: enabled ? 'var(--clay)' : 'var(--fg-tertiary)' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-medium">{site.name}</div>
                    <div className="text-sm" style={{ color: 'var(--fg-tertiary)' }}>{site.desc}</div>
                  </div>
                  <Toggle on={enabled} onToggle={() => toggleSite(site.key)} testId={`toggle-${site.key}`} />
                </div>

                {/* Gmail schedule section */}
                {site.key === 'gmail' && enabled && (
                  <div className="px-5 pb-5 pt-1" style={{ borderBottom: isLast ? 'none' : '1px solid var(--border-tertiary)' }}>
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-sm font-medium" style={{ color: 'var(--fg-secondary)' }}>Time-based schedule</span>
                      <Toggle on={schedule.enabled} onToggle={() => saveSchedule({ enabled: !schedule.enabled })} testId="schedule-toggle" />
                    </div>

                    <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-sm" style={{ background: 'var(--bg-secondary)' }}>
                      <div className="w-2 h-2 rounded-full" style={{ background: isCurrentlyBlocked ? 'var(--error)' : 'var(--olive)' }} />
                      <span className="text-sm" style={{ color: 'var(--fg-secondary)' }}>
                        {!schedule.enabled
                          ? 'Schedule off — Gmail always blocked'
                          : isCurrentlyBlocked
                            ? `Blocked now (until ${formatHour(schedule.allowStart)})`
                            : `Accessible (until ${formatHour(schedule.allowEnd)})`}
                      </span>
                    </div>

                    <div className={`space-y-5 ${!schedule.enabled ? 'opacity-40 pointer-events-none' : ''}`}>
                      <div>
                        <div className="flex justify-between items-baseline mb-2">
                          <label className="text-sm font-medium" style={{ color: 'var(--fg-secondary)' }}>Access starts</label>
                          <span className="text-sm font-mono" style={{ color: 'var(--clay)' }}>{formatHour(schedule.allowStart)}</span>
                        </div>
                        <input
                          type="range" min={0} max={23} step={1}
                          value={schedule.allowStart}
                          onChange={(e) => saveSchedule({ allowStart: parseInt(e.target.value) })}
                          className="w-full h-1.5 rounded-full cursor-pointer accent-[var(--clay)]"
                          style={{ background: 'var(--bg-tertiary)' }}
                          data-testid="slider-allow-start"
                        />
                        <div className="flex justify-between text-xs mt-1" style={{ color: 'var(--fg-tertiary)' }}>
                          <span>12 AM</span><span>12 PM</span><span>11 PM</span>
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between items-baseline mb-2">
                          <label className="text-sm font-medium" style={{ color: 'var(--fg-secondary)' }}>Access ends</label>
                          <span className="text-sm font-mono" style={{ color: 'var(--clay)' }}>{formatHour(schedule.allowEnd)}</span>
                        </div>
                        <input
                          type="range" min={0} max={23} step={1}
                          value={schedule.allowEnd}
                          onChange={(e) => saveSchedule({ allowEnd: parseInt(e.target.value) })}
                          className="w-full h-1.5 rounded-full cursor-pointer accent-[var(--clay)]"
                          style={{ background: 'var(--bg-tertiary)' }}
                          data-testid="slider-allow-end"
                        />
                        <div className="flex justify-between text-xs mt-1" style={{ color: 'var(--fg-tertiary)' }}>
                          <span>12 AM</span><span>12 PM</span><span>11 PM</span>
                        </div>
                      </div>

                      <div className="pt-1">
                        <div className="flex items-center gap-2 mb-2">
                          <Clock size={14} style={{ color: 'var(--fg-tertiary)' }} />
                          <span className="text-xs" style={{ color: 'var(--fg-tertiary)' }}>
                            {blockedHours}h blocked · {24 - blockedHours}h accessible
                          </span>
                        </div>
                        <div className="h-3 rounded-full overflow-hidden flex" style={{ background: 'var(--bg-tertiary)' }}>
                          {Array.from({ length: 24 }, (_, i) => {
                            const { allowStart, allowEnd } = schedule;
                            const allowed = allowStart < allowEnd
                              ? i >= allowStart && i < allowEnd
                              : i >= allowStart || i < allowEnd;
                            return (
                              <div
                                key={i}
                                className="flex-1 transition-colors"
                                style={{
                                  background: allowed ? 'var(--olive)' : 'color-mix(in srgb, var(--error) 40%, transparent)',
                                  opacity: i === now ? 1 : 0.7,
                                  borderRight: i < 23 ? '1px solid var(--bg-primary)' : 'none',
                                }}
                                title={`${formatHour(i)} — ${allowed ? 'Accessible' : 'Blocked'}`}
                              />
                            );
                          })}
                        </div>
                        <div className="flex justify-between text-xs mt-1" style={{ color: 'var(--fg-tertiary)' }}>
                          <span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-sm mt-4" style={{ color: 'var(--fg-tertiary)' }}>
          Changes apply on next page load.
        </p>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(createElement(App));
