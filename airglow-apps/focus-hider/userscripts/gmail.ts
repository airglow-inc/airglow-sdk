/**
 * Focus Hider — Gmail time-based blocker
 * Blocks Gmail access outside allowed hours (default: allow 2am–11am only)
 */
// @ts-ignore — airglow SDK injected at runtime
declare const airglow: any; // eslint-disable-line

import tokensCSS from '../../shared/theme/tokens-injectable';

const STORAGE_KEY = 'focus_hider_schedule';
const THEME_KEY = 'focus_hider_theme';
const DEFAULT_ALLOW_START = 2;  // 2am
const DEFAULT_ALLOW_END = 11;   // 11am

const overlay = document.createElement('div');
overlay.id = 'airglow-focus-hider-gmail';
overlay.style.cssText = `
  position: fixed; inset: 0; z-index: 2147483645;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  opacity: 0; transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1);
`;
overlay.innerHTML = `
  <style>
    ${tokensCSS}
    #airglow-focus-hider-gmail {
      --fh-bg: #1a1a2e;
      --fh-clock-face: #252545;
      --fh-clock-ring: #2a2a4a;
      --fh-hour-marker: #6366f1;
      --fh-minute-marker: #3a3a5a;
      --fh-arc: rgba(239, 68, 68, 0.15);
      --fh-hand: #e0e0e0;
      --fh-accent: #6366f1;
      --fh-title: #f0f0f0;
      --fh-subtitle: #9ca3af;
      --fh-pulse-opacity: 0.5;
    }
    #airglow-focus-hider-gmail.fh-light {
      --fh-bg: #f5f4f1;
      --fh-clock-face: #fafaf8;
      --fh-clock-ring: #dddbd5;
      --fh-hour-marker: #a0a099;
      --fh-minute-marker: #d0cec8;
      --fh-arc: rgba(180, 120, 120, 0.12);
      --fh-hand: #6b6a66;
      --fh-accent: #8a9bb5;
      --fh-title: #55544f;
      --fh-subtitle: #9a998f;
      --fh-pulse-opacity: 0.4;
    }
    #fh-theme-toggle {
      position: fixed; top: 24px; left: 24px;
      width: 36px; height: 36px; border-radius: 50%; border: none;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      background: var(--fh-clock-face); color: var(--fh-accent);
      transition: background 0.3s, color 0.3s;
    }
    #fh-theme-toggle:hover { opacity: 0.8; }
  </style>
  <button id="fh-theme-toggle" title="Toggle theme">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  </button>
  <div id="fh-clock" style="margin-bottom: 40px;">
    <svg width="200" height="200" viewBox="0 0 200 200">
      <circle cx="100" cy="100" r="95" fill="var(--fh-clock-face)" stroke="var(--fh-clock-ring)" stroke-width="2" style="transition: fill 0.3s, stroke 0.3s;"/>
      <circle cx="100" cy="100" r="88" fill="none" stroke="var(--fh-clock-ring)" stroke-width="0.5" style="transition: stroke 0.3s;"/>
      ${Array.from({length: 12}, (_, i) => {
        const angle = (i * 30 - 90) * Math.PI / 180;
        const x1 = 100 + 80 * Math.cos(angle);
        const y1 = 100 + 80 * Math.sin(angle);
        const x2 = 100 + 88 * Math.cos(angle);
        const y2 = 100 + 88 * Math.sin(angle);
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--fh-hour-marker)" stroke-width="2" stroke-linecap="round" style="transition: stroke 0.3s;"/>`;
      }).join('')}
      ${Array.from({length: 60}, (_, i) => {
        if (i % 5 === 0) return '';
        const angle = (i * 6 - 90) * Math.PI / 180;
        const x1 = 100 + 84 * Math.cos(angle);
        const y1 = 100 + 84 * Math.sin(angle);
        const x2 = 100 + 88 * Math.cos(angle);
        const y2 = 100 + 88 * Math.sin(angle);
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--fh-minute-marker)" stroke-width="1" stroke-linecap="round" style="transition: stroke 0.3s;"/>`;
      }).join('')}
      <path id="fh-blocked-arc" fill="none" stroke="var(--fh-arc)" stroke-width="12" style="transition: stroke 0.3s;"/>
      <line id="fh-hour-hand" x1="100" y1="100" x2="100" y2="50" stroke="var(--fh-hand)" stroke-width="3.5" stroke-linecap="round" style="transition: stroke 0.3s;"/>
      <line id="fh-minute-hand" x1="100" y1="100" x2="100" y2="35" stroke="var(--fh-hand)" stroke-width="2" stroke-linecap="round" style="transition: stroke 0.3s;"/>
      <line id="fh-second-hand" x1="100" y1="100" x2="100" y2="30" stroke="var(--fh-accent)" stroke-width="1" stroke-linecap="round" style="transition: stroke 0.3s;"/>
      <circle cx="100" cy="100" r="4" fill="var(--fh-accent)" style="transition: fill 0.3s;"/>
      <circle cx="100" cy="100" r="4" fill="var(--fh-accent)" style="transition: fill 0.3s;">
        <animate attributeName="r" values="4;8;4" dur="2s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.5;0;0.5" dur="2s" repeatCount="indefinite"/>
      </circle>
    </svg>
  </div>
  <div style="text-align: center; max-width: 500px; padding: 0 24px;">
    <h1 id="fh-title" style="font-size: 32px; font-weight: 600; margin: 0 0 12px; color: var(--fh-title); letter-spacing: -0.02em; transition: color 0.3s;">
      Gmail is paused
    </h1>
    <p id="fh-schedule-text" style="font-size: 18px; line-height: 1.5; color: var(--fh-subtitle); margin: 0; transition: color 0.3s;">
      Your feed is hidden — stay focused on what matters.
    </p>
    <div id="fh-time-display" style="font-family: 'JetBrains Mono', monospace; font-size: 48px; font-weight: 300; color: var(--fh-accent); margin-top: 32px; letter-spacing: 2px; transition: color 0.3s;"></div>
  </div>
`;

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = { x: cx + r * Math.cos(startAngle), y: cy + r * Math.sin(startAngle) };
  const end = { x: cx + r * Math.cos(endAngle), y: cy + r * Math.sin(endAngle) };
  const largeArc = (endAngle - startAngle > Math.PI) ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function updateClock() {
  const now = new Date();
  const h = now.getHours() % 12;
  const m = now.getMinutes();
  const s = now.getSeconds();
  const ms = now.getMilliseconds();

  const hourAngle = (h * 30 + m * 0.5) - 90;
  const minuteAngle = (m * 6 + s * 0.1) - 90;
  const secondAngle = ((s + ms / 1000) * 6) - 90;

  const hourHand = overlay.querySelector('#fh-hour-hand') as SVGLineElement;
  const minuteHand = overlay.querySelector('#fh-minute-hand') as SVGLineElement;
  const secondHand = overlay.querySelector('#fh-second-hand') as SVGLineElement;
  if (hourHand) {
    const rad = hourAngle * Math.PI / 180;
    hourHand.setAttribute('x2', String(100 + 45 * Math.cos(rad)));
    hourHand.setAttribute('y2', String(100 + 45 * Math.sin(rad)));
  }
  if (minuteHand) {
    const rad = minuteAngle * Math.PI / 180;
    minuteHand.setAttribute('x2', String(100 + 60 * Math.cos(rad)));
    minuteHand.setAttribute('y2', String(100 + 60 * Math.sin(rad)));
  }
  if (secondHand) {
    const rad = secondAngle * Math.PI / 180;
    secondHand.setAttribute('x2', String(100 + 60 * Math.cos(rad)));
    secondHand.setAttribute('y2', String(100 + 60 * Math.sin(rad)));
  }

  const timeDisplay = overlay.querySelector('#fh-time-display') as HTMLElement;
  if (timeDisplay) {
    timeDisplay.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  requestAnimationFrame(updateClock);
}

function drawBlockedArc(allowStart: number, allowEnd: number) {
  const startDeg = ((allowEnd % 12) * 30 - 90) * Math.PI / 180;
  const endDeg = ((allowStart % 12) * 30 - 90) * Math.PI / 180;
  const arc = overlay.querySelector('#fh-blocked-arc') as SVGPathElement;
  if (arc) {
    let sweep = endDeg - startDeg;
    if (sweep <= 0) sweep += 2 * Math.PI;
    if (sweep > 0) {
      arc.setAttribute('d', describeArc(100, 100, 75, startDeg, startDeg + sweep));
    }
  }
}

function isBlocked(allowStart: number, allowEnd: number): boolean {
  const hour = new Date().getHours();
  if (allowStart < allowEnd) {
    return !(hour >= allowStart && hour < allowEnd);
  } else {
    return !(hour >= allowStart || hour < allowEnd);
  }
}

function applyTheme(dark: boolean) {
  overlay.style.background = dark ? '#1a1a2e' : '#f5f4f1';
  overlay.classList.toggle('fh-light', !dark);
  // Swap toggle icon: sun for dark mode, moon for light mode
  const btn = overlay.querySelector('#fh-theme-toggle') as HTMLElement;
  if (btn) {
    btn.innerHTML = dark
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }
}

async function init() {
  try {
    const sitesVal = await airglow.storage.get('focus_hider_sites');
    if (sitesVal) {
      const sites = JSON.parse(sitesVal);
      if (sites.gmail === false) return;
    }
  } catch {}

  let allowStart = DEFAULT_ALLOW_START;
  let allowEnd = DEFAULT_ALLOW_END;
  let isDark = true;

  try {
    const [settings, theme] = await Promise.all([
      airglow.storage.get(STORAGE_KEY),
      airglow.storage.get(THEME_KEY),
    ]);
    if (settings) {
      const parsed = JSON.parse(settings);
      if (parsed.allowStart != null) allowStart = parsed.allowStart;
      if (parsed.allowEnd != null) allowEnd = parsed.allowEnd;
      if (parsed.enabled === false) return;
    }
    if (theme != null) isDark = theme === 'dark';
  } catch {}

  if (!isBlocked(allowStart, allowEnd)) return;

  // Apply theme and show overlay
  applyTheme(isDark);
  (document.body || document.documentElement).appendChild(overlay);
  requestAnimationFrame(() => { overlay.style.opacity = '1'; });

  // Toggle handler
  overlay.querySelector('#fh-theme-toggle')?.addEventListener('click', () => {
    isDark = !isDark;
    applyTheme(isDark);
    try { airglow.storage.set(THEME_KEY, isDark ? 'dark' : 'light'); } catch {}
  });

  drawBlockedArc(allowStart, allowEnd);
  requestAnimationFrame(updateClock);

  // Check every minute if we should unblock
  setInterval(() => {
    if (!isBlocked(allowStart, allowEnd)) {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 300);
    }
  }, 60000);
}

// ── Title stripping (remove unread count like "Inbox (1)") ──

function stripGmailTitleCount() {
  const clean = document.title.replace(/\(\d+\)\s*/, '').replace(/^Inbox\s*-\s*/, 'Inbox - ');
  if (document.title !== clean) document.title = clean;
}

(function initTitleStrip() {
  stripGmailTitleCount();
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(stripGmailTitleCount)
      .observe(titleEl, { childList: true, characterData: true, subtree: true });
  } else {
    // Title element may not exist yet at document_end
    new MutationObserver((_, obs) => {
      const t = document.querySelector('title');
      if (t) {
        obs.disconnect();
        stripGmailTitleCount();
        new MutationObserver(stripGmailTitleCount)
          .observe(t, { childList: true, characterData: true, subtree: true });
      }
    }).observe(document.head || document.documentElement, { childList: true, subtree: true });
  }
})();

if (document.body) {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
