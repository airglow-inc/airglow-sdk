// Focus Hider — LinkedIn
// Full-block mode (default): replaces the entire site with a focus screen.
// Feed-only mode: hides posts, composer, right rail, distracting sidebars.
// @ts-ignore — airglow SDK injected at runtime
declare const airglow: any; // eslint-disable-line

;(function () {

const FULL_BLOCK_KEY = 'focus_hider_linkedin_full_block';
const FULL_OVERLAY_ID = 'airglow-focus-hider-li-full';

const FULL_BLOCK_CSS = `
html.airglow-li-blocked, html.airglow-li-blocked body {
  overflow: hidden !important;
}
#${FULL_OVERLAY_ID} {
  position: fixed; inset: 0; z-index: 2147483645;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: #1a1a2e; color: #e2e4eb;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  opacity: 0; transition: opacity 0.3s ease-out;
}
#${FULL_OVERLAY_ID}.visible { opacity: 1; }
#${FULL_OVERLAY_ID} .afb-clock { margin-bottom: 36px; }
#${FULL_OVERLAY_ID} .afb-title {
  font-size: 32px; font-weight: 600; letter-spacing: -0.02em;
  margin: 0 0 12px; color: #f0f0f0;
}
#${FULL_OVERLAY_ID} .afb-sub {
  font-size: 18px; line-height: 1.5; color: #9ca3af; margin: 0;
  max-width: 480px; text-align: center; padding: 0 24px;
}
`;

function buildFullOverlay(): HTMLElement {
  const el = document.createElement('div');
  el.id = FULL_OVERLAY_ID;
  el.innerHTML = `
    <div class="afb-clock">${CLOCK_SVG}</div>
    <h1 class="afb-title">Time to do great things</h1>
    <p class="afb-sub">Your feed is hidden — stay focused on what matters.</p>
  `;
  return el;
}

function ensureFullBlockStyle() {
  const ID = 'airglow-focus-hider-li-full-style';
  if (document.getElementById(ID)) return;
  const style = document.createElement('style');
  style.id = ID;
  style.textContent = FULL_BLOCK_CSS;
  (document.head || document.documentElement).appendChild(style);
}

function showFullBlock() {
  ensureFullBlockStyle();
  document.documentElement.classList.add('airglow-li-blocked');
  if (document.getElementById(FULL_OVERLAY_ID)) return;
  const overlay = buildFullOverlay();
  (document.body || document.documentElement).appendChild(overlay);
  requestAnimationFrame(() => {
    overlay.classList.add('visible');
    if (!clockRaf) clockRaf = requestAnimationFrame(tickClock);
  });
  // The overlay may be appended before <body> exists; re-parent to body once it does.
  if (!document.body) {
    const reparent = new MutationObserver(() => {
      if (document.body && overlay.parentElement !== document.body) {
        document.body.appendChild(overlay);
        reparent.disconnect();
      }
    });
    reparent.observe(document.documentElement, { childList: true, subtree: true });
  }
}

const STYLE_ID = 'airglow-focus-hider-li';

/* LinkedIn ships randomized hashed class names that rotate every build, so all
   selectors below key off stable data-view-name attributes instead of classes. */
const FEED_CSS = `
/* Hide feed posts (including promoted), composer, sort toggle, new-posts pill */
[data-view-name="feed-full-update"],
[data-view-name="share-sharebox-focus"],
[data-view-name="feed-nav-feed-sort-toggle"],
[data-view-name="feed-new-update-pill"] {
  display: none !important;
}

/* Motivational banner */
#airglow-focus-banner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 32px;
  margin-top: 16px;
  border-radius: 12px;
  background: #1a1d2e;
  text-align: center;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  animation: airglow-fade-in 0.6s ease-out;
}
#airglow-focus-banner .afb-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.5px;
  margin: 0 0 12px;
  line-height: 1.2;
  color: #e2e4eb;
}
#airglow-focus-banner .afb-sub {
  font-size: 18px;
  font-weight: 400;
  margin: 0;
  color: #9ca3af;
}
@keyframes airglow-fade-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
`;

/* Styles applied on ALL LinkedIn pages (not just feed) */
const GLOBAL_CSS = `
/* Hide the feed's right rail (news, promoted, puzzles). Profile-page sidebars
   are handled separately by hideDistractingSections() via heading text. */
aside:has([data-view-name="news-module"]) {
  display: none !important;
}

/* Hide messaging overlay (bottom-right chat widget) */
.msg-overlay-bubble-header,
.msg-overlay-list-bubble,
.msg-overlay-container,
aside.msg-overlay-container-node,
div[class*="msg-overlay"] {
  display: none !important;
}

/* Hide notification count badges in nav (red circles with numbers).
   LinkedIn has two nav variants: old (class-based) and new (obfuscated). */
.notification-badge--show,
.notification-badge__count,
[aria-label*="new notification"] span[data-color-scheme],
[aria-label*="new update"] span[data-color-scheme],
[aria-label*="new message"] span[data-color-scheme],
[aria-label*="new invite"] span[data-color-scheme] {
  display: none !important;
}
`;

const GLOBAL_STYLE_ID = 'airglow-focus-hider-li-global';

const BANNER_ID = 'airglow-focus-banner';
let clockRaf = 0;

const CLOCK_SVG = `<svg width="160" height="160" viewBox="0 0 200 200">
  <circle cx="100" cy="100" r="95" fill="#252545" stroke="#2a2a4a" stroke-width="2"/>
  <circle cx="100" cy="100" r="88" fill="none" stroke="#2a2a4a" stroke-width="0.5"/>
  ${Array.from({length: 12}, (_, i) => {
    const a = (i * 30 - 90) * Math.PI / 180;
    return `<line x1="${100 + 80 * Math.cos(a)}" y1="${100 + 80 * Math.sin(a)}" x2="${100 + 88 * Math.cos(a)}" y2="${100 + 88 * Math.sin(a)}" stroke="#6366f1" stroke-width="2" stroke-linecap="round"/>`;
  }).join('')}
  ${Array.from({length: 60}, (_, i) => {
    if (i % 5 === 0) return '';
    const a = (i * 6 - 90) * Math.PI / 180;
    return `<line x1="${100 + 84 * Math.cos(a)}" y1="${100 + 84 * Math.sin(a)}" x2="${100 + 88 * Math.cos(a)}" y2="${100 + 88 * Math.sin(a)}" stroke="#3a3a5a" stroke-width="1" stroke-linecap="round"/>`;
  }).join('')}
  <line id="afb-hour" x1="100" y1="100" x2="100" y2="50" stroke="#e0e0e0" stroke-width="3.5" stroke-linecap="round"/>
  <line id="afb-min" x1="100" y1="100" x2="100" y2="35" stroke="#e0e0e0" stroke-width="2" stroke-linecap="round"/>
  <line id="afb-sec" x1="100" y1="100" x2="100" y2="30" stroke="#6366f1" stroke-width="1" stroke-linecap="round"/>
  <circle cx="100" cy="100" r="4" fill="#6366f1"/>
  <circle cx="100" cy="100" r="4" fill="#6366f1">
    <animate attributeName="r" values="4;8;4" dur="2s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0.5;0;0.5" dur="2s" repeatCount="indefinite"/>
  </circle>
</svg>`;

function tickClock() {
  const banner = document.getElementById(BANNER_ID);
  if (!banner) { clockRaf = 0; return; }
  const now = new Date();
  const h = now.getHours() % 12, m = now.getMinutes(), s = now.getSeconds(), ms = now.getMilliseconds();
  const hands: [string, number, number][] = [
    ['#afb-hour', (h * 30 + m * 0.5) - 90, 45],
    ['#afb-min',  (m * 6 + s * 0.1) - 90, 60],
    ['#afb-sec',  ((s + ms / 1000) * 6) - 90, 60],
  ];
  for (const [sel, deg, len] of hands) {
    const el = banner.querySelector(sel) as SVGLineElement | null;
    if (!el) continue;
    const rad = deg * Math.PI / 180;
    el.setAttribute('x2', String(100 + len * Math.cos(rad)));
    el.setAttribute('y2', String(100 + len * Math.sin(rad)));
  }
  clockRaf = requestAnimationFrame(tickClock);
}

// LinkedIn lays the feed out as the middle of a 3-column <section>
// [left profile rail | center feed | right news rail]. Class names are
// build-randomized, so locate the columns structurally: climb from the composer
// (its aria-label is stable; data-view-name is a fallback for an older build) to
// the column that is a direct child of the layout <section>.
function feedColumns(): { grid: HTMLElement; center: HTMLElement } | null {
  const composer = document.querySelector(
    '[aria-label="Start a post"], [data-view-name="share-sharebox-focus"]'
  );
  if (!composer) return null;
  let center = composer as HTMLElement;
  while (center.parentElement && center.tagName !== 'SECTION') {
    center = center.parentElement;
  }
  const grid = center.parentElement;
  if (center.tagName !== 'SECTION' || !grid) return null;
  return { grid, center };
}

// Hide the feed (center column content) and every rail to its right (news, ads,
// puzzles), then drop the banner into the center column. Keeps the left profile rail.
function injectBanner() {
  if (!isFeedPage()) return;
  const cols = feedColumns();
  if (!cols) return;
  for (const child of Array.from(cols.center.children) as HTMLElement[]) {
    if (child.id !== BANNER_ID) child.style.setProperty('display', 'none', 'important');
  }
  const sections = Array.from(cols.grid.children) as HTMLElement[];
  for (const s of sections.slice(sections.indexOf(cols.center) + 1)) {
    s.style.setProperty('display', 'none', 'important');
  }

  if (document.getElementById(BANNER_ID)) return;
  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.innerHTML = `
    <div style="margin-bottom: 28px;">${CLOCK_SVG}</div>
    <p class="afb-title">Time to do great things</p>
    <p class="afb-sub">Your feed is hidden — stay focused on what matters.</p>
  `;
  cols.center.prepend(banner);
  if (!clockRaf) clockRaf = requestAnimationFrame(tickClock);
}

function removeBanner() {
  document.getElementById(BANNER_ID)?.remove();
  if (clockRaf) { cancelAnimationFrame(clockRaf); clockRaf = 0; }
}

const HIDE_PATTERNS = [
  'More profiles for you',
  'you may know',
  'People also viewed',
  'your viewers also viewed',
  'People to follow',
  'More suggestions for you',
  'Suggestions for you',
  'Based on your recent activity',
  'Explore Premium',
  'You might like',
  'People who are hiring',
  'providers you might be interested in',
];

function isFeedPage() {
  // Direct load: /feed/ or /. SPA nav: LinkedIn loads feed in /preload/ iframe.
  return /^\/(feed\/?)?$/.test(location.pathname) || location.pathname === '/preload/';
}

function isCompanyPage() {
  // Company pages (incl. /people/) are visited intentionally; their employee
  // list is headed "People you may know", which would otherwise be hidden as a
  // distraction. Skip section-hiding here so the people list stays visible.
  return /^\/company\//.test(location.pathname);
}

function updateFeedStyle() {
  const existing = document.getElementById(STYLE_ID);
  if (isFeedPage()) {
    if (!existing) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = FEED_CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    injectBanner();
  } else {
    existing?.remove();
    removeBanner();
  }
}

function hideMessagingOverlay() {
  if (!document.body) return;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    if (tw.currentNode.textContent?.trim() !== 'Messaging') continue;
    let el = tw.currentNode.parentElement;
    for (let i = 0; i < 10 && el && el !== document.body; i++) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'absolute') {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > window.innerHeight - 100) {
          el.style.setProperty('display', 'none', 'important');
        }
        break;
      }
      el = el.parentElement;
    }
    break;
  }
}

function hideDistractingSections(root: ParentNode = document) {
  if (isCompanyPage()) return;
  const headings = root.querySelectorAll('h2, h3');
  for (const h of headings) {
    const text = h.textContent?.trim() || '';
    if (HIDE_PATTERNS.some((p) => text.includes(p))) {
      const section = h.closest('section') || h.parentElement?.parentElement?.parentElement;
      if (section instanceof HTMLElement && section.style.display !== 'none') {
        section.style.display = 'none';
      }
    }
  }
}

async function init() {
  let siteEnabled = true;
  let fullBlock = true; // default to full-site block

  try {
    const sitesVal = await airglow.storage.get('focus_hider_sites');
    if (sitesVal) {
      const sites = JSON.parse(sitesVal);
      if (sites.linkedin === false) siteEnabled = false;
    }
  } catch {}

  try {
    const v = await airglow.storage.get(FULL_BLOCK_KEY);
    if (v === 'false' || v === false) fullBlock = false;
  } catch {}

  if (!siteEnabled) return;

  if (fullBlock) {
    showFullBlock();
    return;
  }

  // ── Feed-only mode (legacy behaviour) ──

  if (!document.getElementById(GLOBAL_STYLE_ID)) {
    const gs = document.createElement('style');
    gs.id = GLOBAL_STYLE_ID;
    gs.textContent = GLOBAL_CSS;
    (document.head || document.documentElement).appendChild(gs);
  }

  updateFeedStyle();
  hideDistractingSections();
  hideMessagingOverlay();

  const observer = new MutationObserver(() => {
    hideDistractingSections();
    hideMessagingOverlay();
    injectBanner();
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } else {
    const earlyObserver = new MutationObserver(() => {
      if (document.documentElement) {
        earlyObserver.disconnect();
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    });
    earlyObserver.observe(document, { childList: true });
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      updateFeedStyle();
      hideDistractingSections();
      hideMessagingOverlay();
    }
  }, 500);
}

init();

})();
