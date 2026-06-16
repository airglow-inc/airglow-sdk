// Renders the active server-driven announcement (if any). Reads the cached
// array the background polls into storage, picks the one to show with the
// shared rule, and renders the markdown body through a sanitizing renderer
// (links + text, no raw HTML). Dismissal persists the id so it stays gone.
//
// Pass `override` to render a fixed announcement and bypass storage — used by
// the standalone preview page (announcement-preview.html).

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, Megaphone, TriangleAlert } from 'lucide-react';
import {
  ANNOUNCEMENTS_CACHE_KEY,
  ANNOUNCEMENTS_DISMISSED_KEY,
  INSTALLED_AT_KEY,
  pickAnnouncement,
  type Announcement,
} from '../lib/announcements';

// Inline-styled markdown so the banner renders identically in any entrypoint
// without depending on a page-level `.md` stylesheet. Restricted to text/link
// elements — react-markdown emits no raw HTML, so server content can't inject.
const mdComponents = {
  a: (p: any) => <a {...p} target="_blank" rel="noreferrer" style={{ color: 'var(--clay)', textDecoration: 'underline' }} />,
  p: (p: any) => <p {...p} style={{ margin: '0 0 8px' }} />,
  ul: (p: any) => <ul {...p} style={{ margin: '0 0 8px', paddingLeft: 18, listStyle: 'disc' }} />,
  ol: (p: any) => <ol {...p} style={{ margin: '0 0 8px', paddingLeft: 20, listStyle: 'decimal' }} />,
  li: (p: any) => <li {...p} style={{ margin: '2px 0' }} />,
  strong: (p: any) => <strong {...p} style={{ fontWeight: 600 }} />,
  code: (p: any) => <code {...p} style={{ background: 'var(--bg-tertiary)', padding: '1px 5px', borderRadius: 4, fontSize: '0.92em' }} />,
};

export function AnnouncementBanner({ override, compact }: { override?: Announcement | null; compact?: boolean }) {
  const [active, setActive] = useState<Announcement | null>(override ?? null);

  useEffect(() => {
    if (override !== undefined) { setActive(override); return; }
    let cancelled = false;
    const recompute = async () => {
      const r = await chrome.storage.local.get([
        ANNOUNCEMENTS_CACHE_KEY, ANNOUNCEMENTS_DISMISSED_KEY, INSTALLED_AT_KEY,
      ]);
      if (cancelled) return;
      const list: Announcement[] = Array.isArray(r[ANNOUNCEMENTS_CACHE_KEY]) ? r[ANNOUNCEMENTS_CACHE_KEY] : [];
      const dismissed: string[] = Array.isArray(r[ANNOUNCEMENTS_DISMISSED_KEY]) ? r[ANNOUNCEMENTS_DISMISSED_KEY] : [];
      const installedAt: number = typeof r[INSTALLED_AT_KEY] === 'number' ? r[INSTALLED_AT_KEY] : 0;
      const version = chrome.runtime.getManifest().version;
      setActive(pickAnnouncement(list, { installedAt, dismissed, version, now: Date.now() }));
    };
    void recompute();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (ANNOUNCEMENTS_CACHE_KEY in changes || ANNOUNCEMENTS_DISMISSED_KEY in changes || INSTALLED_AT_KEY in changes) void recompute();
    };
    chrome.storage.local.onChanged.addListener(onChange);
    return () => { cancelled = true; chrome.storage.local.onChanged.removeListener(onChange); };
  }, [override]);

  if (!active) return null;

  const critical = active.severity === 'critical';
  const accent = critical ? 'var(--error)' : 'var(--olive)';
  const Icon = critical ? TriangleAlert : Megaphone;

  const dismiss = () => {
    if (override === undefined) {
      chrome.storage.local.get(ANNOUNCEMENTS_DISMISSED_KEY, (r) => {
        const prev: string[] = Array.isArray(r[ANNOUNCEMENTS_DISMISSED_KEY]) ? r[ANNOUNCEMENTS_DISMISSED_KEY] : [];
        if (!prev.includes(active.id)) chrome.storage.local.set({ [ANNOUNCEMENTS_DISMISSED_KEY]: [...prev, active.id] });
      });
    }
    setActive(null);
  };

  return (
    <div
      className={compact ? 'relative mx-3 mt-3 p-3.5 rounded-[8px] border' : 'relative p-5 rounded-[var(--radius-md)] mb-6 border'}
      style={{
        background: `color-mix(in srgb, ${accent} 8%, var(--bg-white))`,
        borderColor: `color-mix(in srgb, ${accent} 30%, var(--border-tertiary))`,
      }}
      data-testid="banner-announcement"
    >
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className={`absolute top-2 right-2 inline-flex items-center justify-center rounded cursor-pointer border ${compact ? 'h-7 w-7' : 'h-8 w-8'}`}
        style={{ background: 'var(--bg-white)', color: 'var(--fg-secondary)', borderColor: `color-mix(in srgb, ${accent} 30%, var(--border-tertiary))` }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--fg-primary)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; e.currentTarget.style.color = 'var(--fg-secondary)'; }}
        data-testid="banner-announcement-dismiss"
      >
        <X size={compact ? 14 : 16} strokeWidth={2.5} />
      </button>
      <div className={`font-semibold flex items-center gap-2 pr-8 ${compact ? 'text-[14px]' : 'text-lg'}`} style={{ color: 'var(--fg-primary)' }}>
        <Icon size={compact ? 16 : 20} style={{ color: accent }} />
        {active.title}
      </div>
      <div className={`leading-relaxed ${compact ? 'mt-2 text-[13px]' : 'mt-3 text-base'}`} style={{ color: 'var(--fg-secondary)', maxWidth: compact ? undefined : 620 }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {active.body}
        </ReactMarkdown>
      </div>
    </div>
  );
}
