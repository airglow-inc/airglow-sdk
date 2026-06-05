// Gmail Calendar — extract meeting details from email threads, pre-fill calendar events
// Runs on mail.google.com via airglow userscript injection
import iconSvg from '../../../extension-source/lib/branding/icon.svg';

interface EventData {
  title?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  guests?: string;
  location?: string;
  description?: string;
}

const match = location.pathname.match(/\/mail\/u\/(\d+)/);
const userIndex = match ? match[1] : '0';

function defaultStartTime(): { date: string; startTime: string; endTime: string } {
  const now = new Date();
  const start = new Date(now);
  if (start.getMinutes() >= 30) start.setHours(start.getHours() + 1);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { date: fmtDate(start), startTime: fmtTime(start), endTime: fmtTime(end) };
}

function getLatestMessageId(): string | null {
  const els = document.querySelectorAll('[data-legacy-message-id]');
  if (!els.length) return null;
  const last = els[els.length - 1];
  return last.getAttribute('data-legacy-message-id');
}

function getLoggedInEmail(): string {
  const titleMatch = document.title.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (titleMatch) return titleMatch[1];
  const accountBtn = document.querySelector('[aria-label*="Google Account"]');
  const labelMatch = accountBtn?.getAttribute('aria-label')?.match(/\(([^)]+@[^)]+)\)/);
  if (labelMatch) return labelMatch[1];
  return '';
}

async function appendLog(entry: Record<string, any>) {
  const logs: any[] = (await airglow.storage.get('extraction_logs')) || [];
  logs.push({ ...entry, ts: new Date().toISOString() });
  // Keep last 200 entries
  if (logs.length > 200) logs.splice(0, logs.length - 200);
  await airglow.storage.set('extraction_logs', logs);
}

async function callExtract(payload: { messageId: string; userEmail: string }): Promise<any> {
  return airglow.rpc('extract', payload);
}

// --- Calendar grid rendering ---

interface CalEvent { id: string; title: string; start: string; end: string; allDay: boolean; color?: string }

const EVENT_COLORS: Record<string, string> = {
  '1': '#7986cb', '2': '#33b679', '3': '#8e24aa', '4': '#e67c73',
  '5': '#f6bf26', '6': '#f4511e', '7': '#039be5', '8': '#616161',
  '9': '#3f51b5', '10': '#0b8043', '11': '#d50000',
};

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_NAMES = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
const MAX_VISIBLE_EVENTS = 6;

function getWeekDays(anchorDate: string): Date[] {
  const [y, m, d] = anchorDate.split('-').map(Number);
  const anchor = new Date(y, m - 1, d);
  const dow = anchor.getDay(); // 0=Sun
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() + mondayOffset);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function eventsForDate(events: CalEvent[], d: Date): { time: string; title: string; color: string }[] {
  const dk = dateKey(d);
  return events
    .filter(ev => ev.start.slice(0, 10) === dk)
    .map(ev => {
      let time = '';
      if (!ev.allDay && ev.start.includes('T')) {
        const t = new Date(ev.start);
        time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
      }
      const color = ev.color === '__proposed__' ? '#e8860c' : (EVENT_COLORS[ev.color || ''] || '#039be5');
      return { time, title: ev.title, color };
    });
}

// weekAnchor is YYYY-MM-DD — the date around which the week is built
function renderWeekCalendar(container: HTMLElement, weekAnchor: string, events: CalEvent[], today: Date, proposedDate?: string) {
  const days = getWeekDays(weekAnchor);

  // Header label
  const firstMonth = days[0].getMonth(), lastMonth = days[6].getMonth();
  const firstYear = days[0].getFullYear(), lastYear = days[6].getFullYear();
  let label: string;
  if (firstYear !== lastYear) {
    label = `${SHORT_MONTHS[firstMonth]} ${firstYear} – ${SHORT_MONTHS[lastMonth]} ${lastYear}`;
  } else if (firstMonth !== lastMonth) {
    label = `${SHORT_MONTHS[firstMonth]} – ${SHORT_MONTHS[lastMonth]} ${firstYear}`;
  } else {
    label = `${MONTH_NAMES[firstMonth]} ${firstYear}`;
  }

  let html = `<div style="display:flex; align-items:center; padding:10px 4px 8px; gap:4px;">
    <span id="ag-cal-prev" style="cursor:pointer; user-select:none; font-size:22px; color:#1a73e8; padding:0 6px; font-weight:bold;" title="Previous week">&#x2039;</span>
    <span id="ag-cal-next" style="cursor:pointer; user-select:none; font-size:22px; color:#1a73e8; padding:0 6px; font-weight:bold;" title="Next week">&#x203a;</span>
    <span style="font-size:17px; font-weight:600; color:#202124; margin-left:6px;">${label}</span>
  </div>`;

  // Week grid: 7 equal columns with table layout to enforce equal widths
  html += `<div style="display:grid; grid-template-columns:repeat(7,1fr); border-top:1px solid #dadce0;">`;
  for (let i = 0; i < 7; i++) {
    const day = days[i];
    const dk = dateKey(day);
    const isToday = dk === dateKey(today);
    const isProposed = proposedDate ? dk === proposedDate : false;
    const dayEvents = eventsForDate(events, day);
    const dayNum = day.getDate();

    let numStyle: string;
    if (isProposed) {
      numStyle = 'background:#e8860c; color:#fff; border-radius:50%; width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; font-size:13px; font-weight:500;';
    } else if (isToday) {
      numStyle = 'background:#1a73e8; color:#fff; border-radius:50%; width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; font-size:13px; font-weight:500;';
    } else {
      numStyle = 'font-size:13px; color:#3c4043; padding:2px 0;';
    }

    const borderRight = i < 6 ? 'border-right:1px solid #e8eaed;' : '';
    html += `<div style="${borderRight} padding:6px 4px; min-height:160px; overflow:hidden; min-width:0;">`;
    html += `<div style="text-align:center; margin-bottom:4px;">
      <div style="font-size:11px; font-weight:500; color:#70757a; letter-spacing:0.5px;">${DAY_NAMES[i]}</div>
      <span style="${numStyle}">${dayNum}</span>
    </div>`;

    const visible = dayEvents.slice(0, MAX_VISIBLE_EVENTS);
    const extra = dayEvents.length - MAX_VISIBLE_EVENTS;

    for (const ev of visible) {
      const timeLabel = ev.time ? `${ev.time} ` : '';
      const full = `${timeLabel}${ev.title}`;
      html += `<div style="font-size:11px; line-height:16px; padding:1px 3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#3c4043;" title="${full.replace(/"/g, '&quot;')}">
        <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${ev.color}; margin-right:3px; vertical-align:middle; flex-shrink:0;"></span>${full}
      </div>`;
    }
    if (extra > 0) {
      html += `<div style="font-size:11px; color:#70757a; padding:1px 3px; font-weight:500;">${extra} more</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;

  container.innerHTML = html;
}

// --- Side panel ---
let panelEl: HTMLElement | null = null;
let weekAnchorStr: string = '';
let proposedDateStr: string | undefined;
let proposedEvent: CalEvent | undefined; // the event being created, shown in orange

// Event cache: "YYYY-MM" → CalEvent[]
const eventCache = new Map<string, CalEvent[]>();
const pendingFetches = new Set<string>();

function monthKey(y: number, m: number): string { return `${y}-${String(m).padStart(2, '0')}`; }

async function fetchMonthEvents(year: number, month: number): Promise<CalEvent[] | 'needsAuth' | null> {
  const key = monthKey(year, month);
  if (eventCache.has(key)) return eventCache.get(key)!;
  if (pendingFetches.has(key)) return null;

  const userEmail = getLoggedInEmail();
  if (!userEmail) return null;

  pendingFetches.add(key);
  try {
    const resp = await airglow.rpc('calendar-events', { userEmail, year, month });
    if (resp?.ok && resp.events) {
      eventCache.set(key, resp.events);
      return resp.events;
    }
    if (resp?.needsAuth && resp?.authUrl) {
      // Store auth URL for later use
      (fetchMonthEvents as any)._authUrl = resp.authUrl;
      return 'needsAuth';
    }
    airglow.log.error(`calendar events failed: ${resp?.error}`);
    return null;
  } catch (e) {
    airglow.log.error(`calendar events error: ${e}`);
    return null;
  } finally {
    pendingFetches.delete(key);
  }
}

function getEventsForWeek(anchor: string): CalEvent[] {
  const days = getWeekDays(anchor);
  // Collect events from all months the week touches
  const months = new Set<string>();
  for (const d of days) months.add(monthKey(d.getFullYear(), d.getMonth() + 1));
  const seen = new Set<string>();
  const all: CalEvent[] = [];
  for (const mk of months) {
    const cached = eventCache.get(mk);
    if (cached) {
      for (const ev of cached) {
        if (!seen.has(ev.id)) { seen.add(ev.id); all.push(ev); }
      }
    }
  }
  return all;
}

function shiftWeek(anchor: string, weeks: number): string {
  const [y, m, d] = anchor.split('-').map(Number);
  const dt = new Date(y, m - 1, d + weeks * 7);
  return dateKey(dt);
}

function wireWeekArrows(calDiv: HTMLElement) {
  calDiv.querySelector('#ag-cal-prev')?.addEventListener('click', () => {
    weekAnchorStr = shiftWeek(weekAnchorStr, -1);
    showWeek(weekAnchorStr);
  });
  calDiv.querySelector('#ag-cal-next')?.addEventListener('click', () => {
    weekAnchorStr = shiftWeek(weekAnchorStr, 1);
    showWeek(weekAnchorStr);
  });
}

function renderCurrentWeek() {
  const calDiv = panelEl?.querySelector('#ag-cal-grid') as HTMLElement | null;
  if (!calDiv) return;
  const events = getEventsForWeek(weekAnchorStr);
  if (proposedEvent) events.push(proposedEvent);
  renderWeekCalendar(calDiv, weekAnchorStr, events, new Date(), proposedDateStr);
  wireWeekArrows(calDiv);
}

async function showWeek(anchor: string) {
  weekAnchorStr = anchor;
  const calDiv = panelEl?.querySelector('#ag-cal-grid') as HTMLElement | null;
  if (!calDiv) return;

  const days = getWeekDays(anchor);
  // Determine which months the week touches
  const months = new Set<string>();
  for (const d of days) months.add(monthKey(d.getFullYear(), d.getMonth() + 1));

  // Check if all months are cached
  const allCached = [...months].every(mk => eventCache.has(mk));
  if (allCached) {
    renderCurrentWeek();
    // Prefetch adjacent weeks' months
    const prevDays = getWeekDays(shiftWeek(anchor, -1));
    const nextDays = getWeekDays(shiftWeek(anchor, 1));
    for (const d of [...prevDays, ...nextDays]) {
      const mk = monthKey(d.getFullYear(), d.getMonth() + 1);
      if (!eventCache.has(mk)) fetchMonthEvents(d.getFullYear(), d.getMonth() + 1);
    }
    return;
  }

  // Render empty, fetch missing months, re-render
  renderWeekCalendar(calDiv, anchor, [], new Date(), proposedDateStr);
  wireWeekArrows(calDiv);

  for (const mk of months) {
    if (!eventCache.has(mk)) {
      const [y, m] = mk.split('-').map(Number);
      const result = await fetchMonthEvents(y, m);
      if (result === 'needsAuth') {
        const authUrl = (fetchMonthEvents as any)._authUrl;
        calDiv.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; padding:20px; text-align:center;">
          <div><div style="font-size:13px; color:#5f6368; margin-bottom:8px;">Connect Google Calendar to see events</div>
          <button id="ag-cal-auth" style="padding:6px 16px; background:#1a73e8; color:#fff; border:none; border-radius:4px; font-size:13px; cursor:pointer;">Connect</button></div>
        </div>`;
        calDiv.querySelector('#ag-cal-auth')?.addEventListener('click', async () => {
          await airglow.openWindowAndWaitClose(authUrl, { width: 560, height: 720 });
          eventCache.clear();
          showWeek(anchor);
        });
        return;
      }
    }
  }

  if (weekAnchorStr === anchor) renderCurrentWeek();

  // Prefetch adjacent
  const prevDays = getWeekDays(shiftWeek(anchor, -1));
  const nextDays = getWeekDays(shiftWeek(anchor, 1));
  for (const d of [...prevDays, ...nextDays]) {
    const mk = monthKey(d.getFullYear(), d.getMonth() + 1);
    if (!eventCache.has(mk)) fetchMonthEvents(d.getFullYear(), d.getMonth() + 1);
  }
}

function buildProposedEvent(): CalEvent {
  const title = (panelEl?.querySelector('#ag-title') as HTMLInputElement)?.value || 'New event';
  const date = (panelEl?.querySelector('#ag-date') as HTMLInputElement)?.value || proposedDateStr || '';
  const start = (panelEl?.querySelector('#ag-start') as HTMLInputElement)?.value || '10:00';
  return {
    id: '__proposed__',
    title,
    start: `${date}T${start}:00`,
    end: '',
    allDay: false,
    color: '__proposed__',
  };
}

function showForm(prefill?: EventData) {
  const defaults = defaultStartTime();
  const p = prefill || {};
  const activeDate = p.date || defaults.date;
  proposedDateStr = activeDate;

  if (panelEl) {
    (panelEl.querySelector('#ag-title') as HTMLInputElement).value = p.title || '';
    (panelEl.querySelector('#ag-date') as HTMLInputElement).value = activeDate;
    (panelEl.querySelector('#ag-start') as HTMLInputElement).value = p.startTime || defaults.startTime;
    (panelEl.querySelector('#ag-end') as HTMLInputElement).value = p.endTime || defaults.endTime;
    (panelEl.querySelector('#ag-guests') as HTMLInputElement).value = p.guests || '';
    (panelEl.querySelector('#ag-location') as HTMLInputElement).value = p.location || '';
    (panelEl.querySelector('#ag-desc') as HTMLTextAreaElement).value = p.description || '';
    panelEl.style.display = 'flex';
    proposedEvent = buildProposedEvent();
    showWeek(activeDate);
    return;
  }

  panelEl = document.createElement('div');
  panelEl.id = 'airglow-cal-form';
  panelEl.style.cssText = `
    position: fixed; bottom: 16px; right: 16px;
    z-index: 1000000; width: 820px;
    max-height: calc(100vh - 32px);
    background: #fff; border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.24);
    font-family: 'Google Sans', Roboto, Arial, sans-serif;
    display: flex; flex-direction: column;
    color: #202124; font-size: 16px;
    overflow: hidden;
  `;
  panelEl.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:14px 20px 10px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <div style="width:24px;height:24px;display:inline-flex">${iconSvg}</div>
        <span style="font-size:18px; font-weight:600;">New event</span>
      </div>
      <div id="ag-form-close" style="cursor:pointer; padding:4px; color:#5f6368; font-size:20px;">&#x2715;</div>
    </div>

    <div style="padding:4px 20px 16px; overflow-y:auto;">
      <input id="ag-title" type="text" placeholder="Add title" autocomplete="off" value="${p.title || ''}" style="
        width:100%; box-sizing:border-box; padding:8px 0; border:none; border-bottom:2px solid #dadce0;
        font-size:22px; margin-bottom:14px; outline:none; background:transparent;
      " />

      <div style="display:flex; gap:16px; margin-bottom:12px;">
        <div style="display:flex; align-items:center; gap:10px; flex:1;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <div style="flex:1;">
            <div style="font-size:12px; font-weight:500; color:#5f6368; margin-bottom:3px;">Date & Time</div>
            <div style="display:flex; gap:6px;">
              <input id="ag-date" type="date" value="${activeDate}" style="
                flex:1; padding:6px 8px; border:1px solid #dadce0; border-radius:6px; font-size:14px; outline:none;
              " />
              <input id="ag-start" type="time" value="${p.startTime || defaults.startTime}" style="
                width:90px; padding:6px 8px; border:1px solid #dadce0; border-radius:6px; font-size:14px; outline:none;
              " />
              <input id="ag-end" type="time" value="${p.endTime || defaults.endTime}" style="
                width:90px; padding:6px 8px; border:1px solid #dadce0; border-radius:6px; font-size:14px; outline:none;
              " />
            </div>
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:10px; flex:1;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <div style="flex:1;">
            <div style="font-size:12px; font-weight:500; color:#5f6368; margin-bottom:3px;">Guests</div>
            <input id="ag-guests" type="text" placeholder="Comma-separated emails" autocomplete="off" value="${p.guests || ''}" style="
              width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid #dadce0; border-radius:6px; font-size:14px; outline:none;
            " />
          </div>
        </div>
      </div>

      <div style="display:flex; gap:16px; margin-bottom:12px; align-items:flex-start;">
        <div style="display:flex; gap:10px; flex:1; align-items:flex-start;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-top:18px; flex-shrink:0;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          <div style="flex:1;">
            <div style="font-size:12px; font-weight:500; color:#5f6368; margin-bottom:3px;">Location</div>
            <input id="ag-location" type="text" placeholder="Add location" autocomplete="off" value="${p.location || ''}" style="
              width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid #dadce0; border-radius:6px; font-size:14px; outline:none;
            " />
          </div>
        </div>

        <div style="display:flex; gap:10px; flex:1; align-items:flex-start;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-top:18px; flex-shrink:0;"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>
          <div style="flex:1;">
            <div style="font-size:12px; font-weight:500; color:#5f6368; margin-bottom:3px;">Description</div>
            <textarea id="ag-desc" placeholder="Add description" rows="2" style="
              width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid #dadce0; border-radius:6px;
              font-size:14px; outline:none; resize:vertical; font-family:inherit;
            ">${p.description || ''}</textarea>
          </div>
        </div>
      </div>

      <button id="ag-submit" style="
        padding:8px 20px; background:#1c1917; color:#fff; border:none; border-radius:8px;
        font-size:15px; font-weight:500; cursor:pointer;
      ">Open in Calendar</button>
    </div>

    <div id="ag-cal-grid" style="border-top:3px solid #1a73e8; background:#f8f9fa; padding:4px 16px 12px;"></div>
  `;
  document.body.appendChild(panelEl);

  const close = () => { panelEl!.style.display = 'none'; };
  panelEl.querySelector('#ag-form-close')!.addEventListener('click', close);

  const updateProposed = () => {
    proposedEvent = buildProposedEvent();
    proposedDateStr = (panelEl!.querySelector('#ag-date') as HTMLInputElement).value;
    renderCurrentWeek();
  };

  // Reload week when date input changes
  panelEl.querySelector('#ag-date')!.addEventListener('change', (e) => {
    const val = (e.target as HTMLInputElement).value;
    if (val) {
      proposedDateStr = val;
      proposedEvent = buildProposedEvent();
      showWeek(val);
    }
  });

  // Update proposed event pill when title or time changes
  panelEl.querySelector('#ag-title')!.addEventListener('input', updateProposed);
  panelEl.querySelector('#ag-start')!.addEventListener('change', updateProposed);

  panelEl.querySelector('#ag-submit')!.addEventListener('click', () => {
    const title = (panelEl!.querySelector('#ag-title') as HTMLInputElement).value;
    const date = (panelEl!.querySelector('#ag-date') as HTMLInputElement).value;
    const startTime = (panelEl!.querySelector('#ag-start') as HTMLInputElement).value;
    const endTime = (panelEl!.querySelector('#ag-end') as HTMLInputElement).value;
    const guestsRaw = (panelEl!.querySelector('#ag-guests') as HTMLInputElement).value;
    const loc = (panelEl!.querySelector('#ag-location') as HTMLInputElement).value;
    const description = (panelEl!.querySelector('#ag-desc') as HTMLTextAreaElement).value;

    const guests = guestsRaw.split(',').map(g => g.trim()).filter(Boolean);

    const [y, m, d] = date.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const dateStr = dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const jsonStr = JSON.stringify({ title, date: dateStr, startTime, endTime, guests, location: loc, description });
    const encoded = btoa(new TextEncoder().encode(jsonStr).reduce((s, b) => s + String.fromCharCode(b), ''));
    const url = `https://calendar.google.com/calendar/u/${userIndex}/r/create#airglow=${encoded}`;
    airglow.openWindow(url, { width: 1150, height: 800 });

    close();
  });

  // Load week calendar with proposed event
  proposedEvent = buildProposedEvent();
  showWeek(activeDate);
}

// --- "Create Meeting" button appended to the Reply/Forward/emoji row ---
const ICON_SVG = `<span style="display:inline-flex; width:20px; height:20px; margin-right:8px; align-items:center; justify-content:center;">${iconSvg}</span>`;

function injectMeetingButton() {
  if (document.getElementById('airglow-create-meeting')) return;

  const links = [...document.querySelectorAll<HTMLElement>('span[role="link"]')];
  const replySpan = links.find((s) => s.textContent?.trim() === 'Reply');
  if (!replySpan) return;

  const row = replySpan.parentElement;
  if (!row || row.children.length < 2) return;

  // Use a real <button> (not role="link") so Gmail's link-click delegation
  // never routes activations from in-body links (e.g. "Unsubscribe") to us.
  const btn = document.createElement('button');
  btn.id = 'airglow-create-meeting';
  btn.type = 'button';
  btn.style.cssText = `
    display: flex; align-items: center;
    height: 36px; padding: 0 16px 0 11px;
    margin: 0;
    border: 2px solid #2563eb; border-radius: 18px;
    color: #2563eb;
    font-family: 'Google Sans', Roboto, RobotoDraft, Helvetica, Arial, sans-serif;
    font-size: 14px; font-weight: 500;
    -webkit-font-smoothing: antialiased;
    cursor: pointer; user-select: none;
    background: transparent;
    transition: background 0.15s;
    appearance: none; -webkit-appearance: none;
    line-height: 1;
  `;
  btn.innerHTML = `${ICON_SVG}Create Meeting`;
  btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(37,99,235,0.08)'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    const origHTML = btn.innerHTML;
    let dotCount = 0;
    let dotInterval: ReturnType<typeof setInterval> | null = null;
    const startDots = (base: string) => {
      dotCount = 0;
      const update = () => { dotCount = (dotCount % 3) + 1; btn.innerHTML = `${ICON_SVG}${base}${'.'.repeat(dotCount)}`; };
      update();
      dotInterval = setInterval(update, 400);
    };
    const stopDots = () => { if (dotInterval) { clearInterval(dotInterval); dotInterval = null; } };

    startDots('Generating');

    const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    try {
      const messageId = getLatestMessageId();
      const userEmail = getLoggedInEmail();
      if (!messageId || !userEmail) {
        airglow.log.info(`missing input: messageId=${messageId} userEmail=${userEmail}`);
        stopDots();
        btn.innerHTML = origHTML;
        showForm();
        return;
      }

      airglow.log.info(`extracting: messageId=${messageId} userEmail=${userEmail}`);

      let resp = await callExtract({ messageId, userEmail });

      // OAuth missing: open popup, wait for user to authorize, then retry
      if (resp?.needsAuth && resp?.authUrl) {
        airglow.log.info(`opening OAuth popup for ${userEmail}`);
        stopDots();
        startDots('Connecting');
        await airglow.openWindowAndWaitClose(resp.authUrl, { width: 560, height: 720 });
        stopDots();
        startDots('Generating');
        resp = await callExtract({ messageId, userEmail });
      }

      stopDots();
      btn.innerHTML = origHTML;

      if (resp?.ok && resp.result) {
        const r = resp.result;
        await appendLog({ reqId, type: 'success', title: r.title, ...resp._log });
        showForm({
          title: r.title || '',
          date: r.date || '',
          startTime: r.startTime || '',
          endTime: r.endTime || '',
          guests: (r.guests || []).join(', '),
          location: r.location || '',
          description: r.description || '',
        });
      } else {
        await appendLog({ reqId, type: 'error', error: resp?.error, ...resp?._log });
        airglow.log.error(`extract failed: ${resp?.error}`);
        showForm();
      }
    } catch (e) {
      stopDots();
      btn.innerHTML = origHTML;
      await appendLog({ reqId, type: 'error', error: String(e) });
      airglow.log.error(`extract error: ${e}`);
      showForm();
    }
  });

  row.appendChild(btn);
}

const observer = new MutationObserver(() => {
  if (document.querySelector('[data-message-id]') && !document.getElementById('airglow-create-meeting')) {
    injectMeetingButton();
  }
});
observer.observe(document.body, { childList: true, subtree: true });

injectMeetingButton();
