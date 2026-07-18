// Standalone preview of the announcement banner — open
// chrome-extension://<id>/announcement-preview.html. Renders the real
// AnnouncementBanner with fixed sample payloads (override bypasses storage), so
// the banner's look can be reviewed without publishing anything to the cloud.

import { AnnouncementBanner } from '../../components/AnnouncementBanner';
import type { Announcement } from '../../lib/announcements';

const INFO: Announcement = {
  id: 'preview-info',
  publishedAt: Date.now(),
  title: 'Gmail → Calendar is now in the catalog',
  body:
    'We just shipped **Gmail → Calendar**, which turns booking emails into calendar events automatically.\n\n' +
    '- Open the **Catalog** tab to install it\n' +
    '- Connect your Google account in **Settings**\n\n' +
    'Questions? [Read the guide](https://airglow.dev/docs).',
  severity: 'info',
  audience: 'all',
};

const CRITICAL: Announcement = {
  id: 'preview-critical',
  publishedAt: Date.now(),
  title: 'Scheduled maintenance Sunday 02:00–02:30 UTC',
  body:
    'The Airglow cloud API will be briefly unavailable during this window. ' +
    'Local apps keep working; cloud-backed features (sign-in, connectors, the agent) may error. ' +
    'No action needed — everything reconnects automatically afterward.',
  severity: 'critical',
  audience: 'all',
};

const HOST_RECOVERY: Announcement = {
  id: 'preview-host-recovery',
  publishedAt: Date.now(),
  title: 'Airglow host needs a one-time reinstall',
  body:
    'Your installed host version has a broken self-updater and cannot update itself. ' +
    'Run this once in a terminal to get the latest version:\n\n' +
    '`curl -fsSL https://airglow.dev/install.sh | bash`\n\n' +
    'Everything else keeps working in the meantime.',
  severity: 'critical',
  audience: 'all',
  maxHostVersion: '0.2.7',
};

// Renders the compact (sidepanel) variant inside a 384px panel-width column,
// over the sidepanel surface color, so the preview matches where it actually
// ships — pinned at the top of the agent sidepanel.
function Panel({ label, a }: { label: string; a: Announcement }) {
  return (
    <div className="mb-10">
      <div className="mb-2 text-sm font-medium uppercase tracking-wide" style={{ color: 'var(--fg-tertiary)' }}>{label}</div>
      <div
        className="rounded-xl overflow-hidden border"
        style={{ width: 384, background: 'var(--bg-primary)', borderColor: 'var(--border-tertiary)' }}
      >
        {/* mimic the sidepanel header bar so the spacing reads true */}
        <div className="h-12 border-b" style={{ background: 'var(--gray-100)', borderColor: 'var(--border-tertiary)' }} />
        <AnnouncementBanner override={a} compact />
        <div style={{ height: 220 }} />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <div className="min-h-screen p-10" style={{ background: 'var(--bg-tertiary)' }}>
      <div className="mx-auto" style={{ maxWidth: 900 }}>
        <h1 className="text-2xl font-semibold tracking-tight mb-1.5" style={{ color: 'var(--fg-primary)' }}>
          Announcement banner — preview
        </h1>
        <p className="text-base mb-8" style={{ color: 'var(--fg-secondary)' }}>
          Both shipped variants. Dismiss is local-only here; in production these are served from Edge Config via <code>/api/announcement</code>.
        </p>
        <div className="mb-2 text-sm font-medium uppercase tracking-wide" style={{ color: 'var(--fg-tertiary)' }}>
          dashboard (full) — host-recovery example (maxHostVersion: 0.2.7)
        </div>
        <div className="rounded-xl border p-8 mb-10" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-tertiary)' }}>
          <AnnouncementBanner override={HOST_RECOVERY} />
        </div>
        <div className="flex flex-wrap gap-10">
          <Panel label="sidepanel (compact) — severity: info" a={INFO} />
          <Panel label="sidepanel (compact) — severity: critical" a={CRITICAL} />
        </div>
      </div>
    </div>
  );
}
