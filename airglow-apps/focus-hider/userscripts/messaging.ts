// Messaging Focus — hides chat list, unread counters, and message previews.
// Works on WhatsApp Web and Telegram Web K.
// Only the search bar remains visible so you can message specific people.
// Always-on — no toggle. Clock in right panel with dark/light theme toggle.

// @ts-ignore — airglow SDK injected at runtime
declare const airglow: any; // eslint-disable-line

const STYLE_ID = 'airglow-msg-focus-style';
const HIDDEN_CLASS = 'airglow-msg-hidden';
const HINT_ID = 'airglow-msg-focus-hint';
const CLOCK_ID = 'airglow-msg-focus-clock';
const SCHEDULE_KEY = 'focus_hider_schedule';
const THEME_KEY = 'focus_hider_theme';
const CLAY = '#dc7a5a';
const DEFAULT_ALLOW_START = 2;
const DEFAULT_ALLOW_END = 11;

type Platform = 'whatsapp' | 'telegram';

function detectPlatform(): Platform {
  if (location.hostname === 'web.whatsapp.com') return 'whatsapp';
  return 'telegram';
}

const platform = detectPlatform();

// ── CSS ──

const whatsappCSS = `
.${HIDDEN_CLASS} { display: none !important; }
[data-testid="icon-unread-count"],
[data-testid="unread-activity-indicator"] { display: none !important; }
[data-testid="chatlist-header"] span[aria-hidden="true"] { display: none !important; }
.airglow-msg-search-pill { box-shadow: 0 0 0 2px ${CLAY} !important; position: relative !important; }
[data-testid="cell-frame-secondary"],
[data-testid="cell-frame-primary-detail"] { display: none !important; }
`;

const telegramCSS = `
.${HIDDEN_CLASS} { display: none !important; }
#chatlist-container > .connection-status-bottom,
#new-menu { display: none !important; }
.chatlist-chat .badge { display: none !important; }
.sidebar-tools-button-notifications { display: none !important; }
.dialog-subtitle { display: none !important; }
.dialog-title-details { display: none !important; }
.stories-list { display: none !important; }
.folders-tabs-scrollable { display: none !important; }
.airglow-msg-search-highlight .input-search { box-shadow: 0 0 0 2px ${CLAY} !important; border-radius: 22px; }
`;

let titleObserver: MutationObserver | null = null;
let faviconObserver: MutationObserver | null = null;

// ── Style injection ──

(function earlyInject() {
  const css = platform === 'whatsapp' ? whatsappCSS : telegramCSS;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
})();

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = platform === 'whatsapp' ? whatsappCSS : telegramCSS;
  document.head.appendChild(style);
}

// ── Sidebar visibility ──

function applySideVisibility() {
  if (platform === 'whatsapp') applySideVisibilityWA();
  else applySideVisibilityTG();
}

function applySideVisibilityWA() {
  const side = document.getElementById('side');
  if (!side) return;

  const searchInput = side.querySelector('[data-testid="chat-list-search-container"] [contenteditable], [data-testid="chat-list-search-container"] input');
  const searchText = searchInput?.textContent?.trim() || (searchInput as HTMLInputElement)?.value?.trim() || '';
  const isSearching = searchText.length > 0;

  for (const child of Array.from(side.children)) {
    const el = child as HTMLElement;
    if (el.querySelector('[data-testid="chat-list-search-container"]')) {
      el.classList.remove(HIDDEN_CLASS);
      continue;
    }
    if (isSearching && el.querySelector('[data-testid="chat-list"]')) {
      el.classList.remove(HIDDEN_CLASS);
      continue;
    }
    if (el.id !== HINT_ID) el.classList.add(HIDDEN_CLASS);
  }

  const hint = document.getElementById(HINT_ID);
  if (hint) hint.style.display = isSearching ? 'none' : 'flex';
}

function applySideVisibilityTG() {
  const columnLeft = document.getElementById('column-left');
  if (!columnLeft) return;

  const contentWrapper = columnLeft.querySelector('#chatlist-container > .connection-status-bottom') as HTMLElement | null;
  contentWrapper?.classList.add(HIDDEN_CLASS);
  document.getElementById('new-menu')?.classList.add(HIDDEN_CLASS);

  const searchInput = columnLeft.querySelector('.input-search-input') as HTMLInputElement | null;
  const searchText = searchInput?.value?.trim() || '';
  const isSearching = searchText.length > 0;

  const hint = document.getElementById(HINT_ID);
  if (hint) hint.style.display = isSearching ? 'none' : 'flex';
}

// ── Title stripping ──

function stripTitleCount() {
  const clean = document.title.replace(/^\(\d+\)\s*/, '');
  if (document.title !== clean) document.title = clean;
}

function enableTitleStrip() {
  stripTitleCount();
  const titleEl = document.querySelector('title');
  if (!titleEl) return;
  titleObserver = new MutationObserver(stripTitleCount);
  titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
}

// ── Favicon stripping ──

const WA_DEFAULT_FAVICON = 'https://static.whatsapp.net/rsrc.php/yd/r/PfkSLByWV8O.webp';
let originalFavicons: { el: HTMLLinkElement; href: string }[] = [];

function captureFavicons() {
  originalFavicons = Array.from(document.querySelectorAll('link[rel*="icon"]')).map(el => ({
    el: el as HTMLLinkElement,
    href: (el as HTMLLinkElement).href,
  }));
}

function resetFavicon() {
  if (platform === 'whatsapp') {
    const icon = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (icon && icon.href !== WA_DEFAULT_FAVICON) icon.href = WA_DEFAULT_FAVICON;
  } else {
    for (const { el, href } of originalFavicons) {
      if (el.href !== href) el.href = href;
    }
  }
}

function enableFaviconStrip() {
  captureFavicons();
  resetFavicon();
  faviconObserver = new MutationObserver(resetFavicon);
  faviconObserver.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
}

// ── Search decoration ──

function decorateSearchBar() {
  if (platform === 'whatsapp') {
    const container = document.querySelector('[data-testid="chat-list-search-container"]');
    if (!container) return;
    for (const el of Array.from(container.querySelectorAll('*'))) {
      const br = getComputedStyle(el).borderRadius;
      if (br && parseInt(br) > 100) {
        el.classList.add('airglow-msg-search-pill');
        break;
      }
    }
  } else {
    document.querySelector('.sidebar-header')?.classList.add('airglow-msg-search-highlight');
  }
}

// ── Hint (sidebar) ──

function showHint() {
  if (document.getElementById(HINT_ID)) return;
  const parent = platform === 'whatsapp'
    ? document.getElementById('side')
    : document.getElementById('chatlist-container');
  if (!parent) return;

  const hint = document.createElement('div');
  hint.id = HINT_ID;
  Object.assign(hint.style, {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: '48px 24px', color: CLAY,
    fontSize: '20px', fontWeight: '500', textAlign: 'center', gap: '12px',
  });
  hint.innerHTML = `<span style="font-size:28px">&#8593;</span>Search for a name to start chatting`;
  parent.appendChild(hint);
}

// ── Clock helpers ──

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = { x: cx + r * Math.cos(startAngle), y: cy + r * Math.sin(startAngle) };
  const end = { x: cx + r * Math.cos(endAngle), y: cy + r * Math.sin(endAngle) };
  const largeArc = (endAngle - startAngle > Math.PI) ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

// ── Clock (right panel) — identical to Gmail blocker ──

function showClock(allowStart: number, allowEnd: number, isDark: boolean) {
  if (document.getElementById(CLOCK_ID)) return;

  // Find the right panel container
  let parent: HTMLElement | null = null;
  if (platform === 'whatsapp') {
    // #side lives inside a sidebar container div. The right panel
    // (intro screen / chat) is the next sibling in the flex-row layout.
    const side = document.getElementById('side');
    const sideContainer = side?.parentElement; // div wrapping header + #side
    const flexRow = sideContainer?.parentElement; // flex row with all panels
    if (flexRow && sideContainer) {
      const idx = Array.from(flexRow.children).indexOf(sideContainer);
      parent = flexRow.children[idx + 1] as HTMLElement || null;
    }
  } else {
    parent = document.getElementById('column-center');
  }
  if (!parent) return;

  // Build hour/minute markers
  const hourMarkers = Array.from({length: 12}, (_, i) => {
    const a = (i * 30 - 90) * Math.PI / 180;
    return `<line x1="${100+80*Math.cos(a)}" y1="${100+80*Math.sin(a)}" x2="${100+88*Math.cos(a)}" y2="${100+88*Math.sin(a)}" stroke="var(--fh-hour-marker)" stroke-width="2" stroke-linecap="round" style="transition: stroke 0.3s;"/>`;
  }).join('');
  const minuteMarkers = Array.from({length: 60}, (_, i) => {
    if (i % 5 === 0) return '';
    const a = (i * 6 - 90) * Math.PI / 180;
    return `<line x1="${100+84*Math.cos(a)}" y1="${100+84*Math.sin(a)}" x2="${100+88*Math.cos(a)}" y2="${100+88*Math.sin(a)}" stroke="var(--fh-minute-marker)" stroke-width="1" stroke-linecap="round" style="transition: stroke 0.3s;"/>`;
  }).join('');

  // Build blocked arc path
  const arcStart = ((allowEnd % 12) * 30 - 90) * Math.PI / 180;
  const arcEnd = ((allowStart % 12) * 30 - 90) * Math.PI / 180;
  let sweep = arcEnd - arcStart;
  if (sweep <= 0) sweep += 2 * Math.PI;
  const arcPath = describeArc(100, 100, 75, arcStart, arcStart + sweep);

  const clock = document.createElement('div');
  clock.id = CLOCK_ID;
  Object.assign(clock.style, {
    position: 'absolute', inset: '0',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    zIndex: '10',
    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    background: 'var(--fh-bg)',
    transition: 'background 0.3s',
  });
  clock.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap');
      #${CLOCK_ID} {
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
      }
      #${CLOCK_ID}.fh-light {
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
      }
      #${CLOCK_ID} .fh-toggle {
        position: absolute; top: 24px; right: 24px;
        width: 36px; height: 36px; border-radius: 50%; border: none;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        background: var(--fh-clock-face); color: var(--fh-accent);
        transition: background 0.3s, color 0.3s;
      }
      #${CLOCK_ID} .fh-toggle:hover { opacity: 0.8; }
    </style>
    <button class="fh-toggle" title="Toggle theme">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
    </button>
    <div style="margin-bottom: 40px;">
      <svg width="200" height="200" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="95" fill="var(--fh-clock-face)" stroke="var(--fh-clock-ring)" stroke-width="2" style="transition: fill 0.3s, stroke 0.3s;"/>
        <circle cx="100" cy="100" r="88" fill="none" stroke="var(--fh-clock-ring)" stroke-width="0.5" style="transition: stroke 0.3s;"/>
        ${hourMarkers}
        ${minuteMarkers}
        <path d="${arcPath}" fill="none" stroke="var(--fh-arc)" stroke-width="12" style="transition: stroke 0.3s;"/>
        <line class="fh-hour-hand" x1="100" y1="100" x2="100" y2="50" stroke="var(--fh-hand)" stroke-width="3.5" stroke-linecap="round" style="transition: stroke 0.3s;"/>
        <line class="fh-minute-hand" x1="100" y1="100" x2="100" y2="35" stroke="var(--fh-hand)" stroke-width="2" stroke-linecap="round" style="transition: stroke 0.3s;"/>
        <line class="fh-second-hand" x1="100" y1="100" x2="100" y2="30" stroke="var(--fh-accent)" stroke-width="1" stroke-linecap="round" style="transition: stroke 0.3s;"/>
        <circle cx="100" cy="100" r="4" fill="var(--fh-accent)" style="transition: fill 0.3s;"/>
        <circle cx="100" cy="100" r="4" fill="var(--fh-accent)" style="transition: fill 0.3s;">
          <animate attributeName="r" values="4;8;4" dur="2s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.5;0;0.5" dur="2s" repeatCount="indefinite"/>
        </circle>
      </svg>
    </div>
    <div style="text-align: center; max-width: 500px; padding: 0 24px;">
      <h1 style="font-size: 32px; font-weight: 600; margin: 0 0 12px; color: var(--fh-title); letter-spacing: -0.02em; transition: color 0.3s;">
        Time to do great things
      </h1>
      <p style="font-size: 18px; line-height: 1.5; color: var(--fh-subtitle); margin: 0; transition: color 0.3s;">
        Your feed is hidden — stay focused on what matters.
      </p>
    </div>
  `;

  // Apply initial theme
  if (!isDark) clock.classList.add('fh-light');

  // Make parent relative for absolute positioning
  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }
  // Hide existing content in the intro pane
  for (const child of Array.from(parent.children)) {
    (child as HTMLElement).style.display = 'none';
  }
  parent.appendChild(clock);

  // Toggle handler
  let dark = isDark;
  clock.querySelector('.fh-toggle')!.addEventListener('click', () => {
    dark = !dark;
    clock.classList.toggle('fh-light', !dark);
    const btn = clock.querySelector('.fh-toggle') as HTMLElement;
    btn.innerHTML = dark
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    try { airglow.storage.set(THEME_KEY, dark ? 'dark' : 'light'); } catch {}
  });

  // Tick
  function tick() {
    const el = document.getElementById(CLOCK_ID);
    if (!el) return;
    const now = new Date();
    const h = now.getHours() % 12, m = now.getMinutes(), s = now.getSeconds(), ms = now.getMilliseconds();
    const ha = (h * 30 + m * 0.5 - 90) * Math.PI / 180;
    const ma = (m * 6 + s * 0.1 - 90) * Math.PI / 180;
    const sa = ((s + ms / 1000) * 6 - 90) * Math.PI / 180;

    const hh = el.querySelector('.fh-hour-hand') as SVGLineElement;
    const mh = el.querySelector('.fh-minute-hand') as SVGLineElement;
    const sh = el.querySelector('.fh-second-hand') as SVGLineElement;
    if (hh) { hh.setAttribute('x2', String(100+45*Math.cos(ha))); hh.setAttribute('y2', String(100+45*Math.sin(ha))); }
    if (mh) { mh.setAttribute('x2', String(100+60*Math.cos(ma))); mh.setAttribute('y2', String(100+60*Math.sin(ma))); }
    if (sh) { sh.setAttribute('x2', String(100+60*Math.cos(sa))); sh.setAttribute('y2', String(100+60*Math.sin(sa))); }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Hide clock when a chat is opened
  function updateClockVisibility() {
    const clockEl = document.getElementById(CLOCK_ID);
    if (!clockEl) return;
    let chatOpen = false;
    if (platform === 'whatsapp') {
      chatOpen = !!document.getElementById('main');
    } else {
      // Telegram: chat is open when hash has a peer (e.g. #@user, #-123456)
      const hash = location.hash;
      chatOpen = hash.length > 1;
    }
    clockEl.style.display = chatOpen ? 'none' : 'flex';
    // Restore/hide intro pane siblings
    if (parent) {
      for (const child of Array.from(parent.children)) {
        if ((child as HTMLElement).id === CLOCK_ID) continue;
        (child as HTMLElement).style.display = chatOpen ? '' : 'none';
      }
    }
  }

  updateClockVisibility();

  if (platform === 'whatsapp') {
    // Watch the right panel itself and its parent for #main appearing
    new MutationObserver(updateClockVisibility).observe(parent, { childList: true, subtree: true });
    if (parent.parentElement) {
      new MutationObserver(updateClockVisibility).observe(parent.parentElement, { childList: true });
    }
  } else {
    // Telegram uses hash navigation — listen for changes and poll
    // because Esc key clears hash without always firing hashchange
    window.addEventListener('hashchange', updateClockVisibility);
    new MutationObserver(updateClockVisibility).observe(parent, { childList: true, subtree: true, attributes: true });
    // Poll hash every second as fallback (Esc doesn't always trigger hashchange)
    setInterval(updateClockVisibility, 1000);
  }
}

// ── Init ──

function init() {
  if (platform === 'whatsapp') initWA();
  else initTG();
}

function isBlocked(allowStart: number, allowEnd: number): boolean {
  const hour = new Date().getHours();
  if (allowStart < allowEnd) {
    return !(hour >= allowStart && hour < allowEnd);
  } else {
    return !(hour >= allowStart || hour < allowEnd);
  }
}

async function loadAndShowClock() {
  let allowStart = DEFAULT_ALLOW_START;
  let allowEnd = DEFAULT_ALLOW_END;
  let isDark = true;
  try {
    const [settings, theme] = await Promise.all([
      airglow.storage.get(SCHEDULE_KEY),
      airglow.storage.get(THEME_KEY),
    ]);
    if (settings) {
      const parsed = JSON.parse(settings);
      if (parsed.allowStart != null) allowStart = parsed.allowStart;
      if (parsed.allowEnd != null) allowEnd = parsed.allowEnd;
    }
    if (theme != null) isDark = theme === 'dark';
  } catch {}
  showClock(allowStart, allowEnd, isDark);
}

function initWA() {
  const side = document.getElementById('side');
  if (!side) { setTimeout(init, 500); return; }

  injectStyle();
  applySideVisibility();
  decorateSearchBar();
  showHint();
  enableTitleStrip();
  enableFaviconStrip();
  loadAndShowClock();

  new MutationObserver(() => applySideVisibility())
    .observe(side, { childList: true, subtree: true, characterData: true });
}

function initTG() {
  const columnLeft = document.getElementById('column-left');
  if (!columnLeft) { setTimeout(init, 500); return; }

  const chatlist = columnLeft.querySelector('.chatlist');
  if (!chatlist) { setTimeout(init, 500); return; }

  injectStyle();
  applySideVisibility();
  decorateSearchBar();
  showHint();
  enableTitleStrip();
  enableFaviconStrip();
  loadAndShowClock();

  const sidebarContent = columnLeft.querySelector('.sidebar-content');
  if (sidebarContent) {
    new MutationObserver(() => applySideVisibility())
      .observe(sidebarContent, { childList: true, subtree: true, characterData: true });
  }

  const searchInput = columnLeft.querySelector('.input-search-input') as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener('input', () => applySideVisibility());
    searchInput.addEventListener('focus', () => setTimeout(applySideVisibility, 100));
  }
}

airglow.storage.get('focus_hider_sites').then((val: string | undefined) => {
  if (val) {
    try {
      const sites = JSON.parse(val);
      if (sites.messaging === false) {
        document.getElementById(STYLE_ID)?.remove();
        return;
      }
    } catch {}
  }
  init();
}).catch(() => init());
