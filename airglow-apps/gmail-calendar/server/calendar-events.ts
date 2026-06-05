import { getClient, hasActiveConnection, initiateOAuth, userIdForEmail } from './_composio';

export default async function calendarEvents(body: {
  userEmail?: string;
  year?: number;
  month?: number; // 1-indexed
}) {
  const { userEmail, year, month } = body;
  if (!userEmail) return { ok: false, error: 'userEmail is required' };
  if (!year || !month) return { ok: false, error: 'year and month are required' };

  const userId = userIdForEmail(userEmail);

  if (!(await hasActiveConnection(userEmail, 'googlecalendar'))) {
    try {
      const { authUrl } = await initiateOAuth(userEmail, 'googlecalendar');
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
    const result = await getClient().tools.execute('GOOGLECALENDAR_EVENTS_LIST', {
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
