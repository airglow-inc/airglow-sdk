import { Composio } from '@composio/core';

let _client: InstanceType<typeof Composio> | null = null;

function getClient(): InstanceType<typeof Composio> {
  if (!_client) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set');
    _client = new Composio({ apiKey });
  }
  return _client;
}

function userIdForEmail(email: string): string {
  return `airglow-gmail-${email.trim().toLowerCase()}`;
}

export default async function calendarEvents(body: {
  userEmail?: string;
  year?: number;
  month?: number; // 1-indexed
}) {
  const { userEmail, year, month } = body;
  if (!userEmail) return { ok: false, error: 'userEmail is required' };
  if (!year || !month) return { ok: false, error: 'year and month are required' };

  const c = getClient();
  const userId = userIdForEmail(userEmail);

  // Check Google Calendar connection (may be separate from Gmail)
  const accounts = await c.connectedAccounts.list({
    userIds: [userId],
    toolkitSlugs: ['googlecalendar'],
  });
  const active = (accounts.items ?? []).find((a: any) => a.status === 'ACTIVE');

  if (!active) {
    try {
      const req = await c.toolkits.authorize(userId, 'googlecalendar');
      let authUrl = req.redirectUrl ?? null;
      // Follow Composio redirect and append login_hint to pre-select account
      if (authUrl && userEmail) {
        try {
          const res = await fetch(authUrl, { redirect: 'manual' });
          const location = res.headers.get('location');
          if (location?.includes('accounts.google.com')) {
            authUrl = `${location}&login_hint=${encodeURIComponent(userEmail)}`;
          }
        } catch {}
      }
      return { ok: false, needsAuth: true, authUrl };
    } catch (e) {
      return { ok: false, error: `Calendar OAuth init failed: ${String(e)}` };
    }
  }

  // Fetch events for the full month view (include surrounding days for the grid)
  // Start from the Monday of the week containing the 1st
  const firstDay = new Date(year, month - 1, 1);
  const dayOfWeek = firstDay.getDay(); // 0=Sun
  const startOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // shift to Monday
  const gridStart = new Date(year, month - 1, 1 + startOffset);
  gridStart.setHours(0, 0, 0, 0);

  // End: 6 weeks from grid start to cover all possible month layouts
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);
  gridEnd.setHours(23, 59, 59, 999);

  try {
    const result = await c.tools.execute('GOOGLECALENDAR_EVENTS_LIST', {
      userId,
      arguments: {
        calendar_id: 'primary',
        timeMin: gridStart.toISOString(),
        timeMax: gridEnd.toISOString(),
        single_events: true,
        order_by: 'startTime',
        max_results: 250,
      },
      dangerouslySkipVersionCheck: true,
    });

    const data = (result as any)?.data || result;
    const items = data?.response_data?.items || data?.items || [];

    const events = items.map((ev: any) => ({
      id: ev.id,
      title: ev.summary || '(No title)',
      start: ev.start?.dateTime || ev.start?.date || '',
      end: ev.end?.dateTime || ev.end?.date || '',
      allDay: !!ev.start?.date && !ev.start?.dateTime,
      color: ev.colorId || undefined,
    }));

    return { ok: true, events, gridStart: gridStart.toISOString(), gridEnd: gridEnd.toISOString() };
  } catch (e) {
    return { ok: false, error: `Calendar fetch failed: ${String(e)}` };
  }
}
