// Focus Hider — LinkedIn
// Feed page: hides posts, composer, sort bar, right sidebar (news, ads, puzzles).
// Profile pages: hides right sidebar and "More profiles for you", "Explore Premium", etc.
// @ts-ignore — airglow SDK injected at runtime
declare const airglow: any; // eslint-disable-line

;(function () {

const STYLE_ID = 'airglow-focus-hider-li';

const FEED_CSS = `
/* Hide feed posts */
.scaffold-finite-scroll {
  display: none !important;
}

/* Hide "Start a post" composer */
.share-box-feed-entry__closed-share-box {
  display: none !important;
}

/* Hide sort bar */
.artdeco-dropdown:has(.feed-index-sort-border) {
  display: none !important;
}

/* Hide "New posts" button */
.feed-new-update-pill {
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
/* Hide right sidebar on all pages (news, promoted, "viewers also viewed", etc.) */
.scaffold-layout__aside {
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

function injectBanner() {
  if (!isFeedPage() || document.getElementById(BANNER_ID)) return;
  const main = document.querySelector('.scaffold-layout__main') ||
               document.querySelector('main');
  if (!main) return;
  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.innerHTML = `
    <div style="margin-bottom: 28px;">${CLOCK_SVG}</div>
    <p class="afb-title">Time to do great things</p>
    <p class="afb-sub">Your feed is hidden — stay focused on what matters.</p>
  `;
  main.appendChild(banner);
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
  'Based on your recent activity',
  'Explore Premium',
  'You might like',
  'People who are hiring',
];

function isFeedPage() {
  // Direct load: /feed/ or /. SPA nav: LinkedIn loads feed in /preload/ iframe.
  return /^\/(feed\/?)?$/.test(location.pathname) || location.pathname === '/preload/';
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

// Inject global styles (messaging overlay + notification badges) on all pages
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
const urlPoller = setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    updateFeedStyle();
    hideDistractingSections();
    hideMessagingOverlay();
  }
}, 500);

airglow.storage.get('focus_hider_sites').then((val: string | undefined) => {
  if (!val) return;
  try {
    const sites = JSON.parse(val);
    if (sites.linkedin === false) {
      document.getElementById(STYLE_ID)?.remove();
      document.getElementById(GLOBAL_STYLE_ID)?.remove();
      removeBanner();
      observer.disconnect();
      clearInterval(urlPoller);
    }
  } catch {}
});

})();
