// Focus Hider — X (Twitter)
// Hides the feed/timeline and the right sidebar (trends, who to follow, news).
// Only active on x.com/home — other routes (notifications, profile, search) are untouched.
// @ts-ignore — airglow SDK injected at runtime
declare const airglow: any; // eslint-disable-line
export {};

;(function () {

const STYLE_ID = 'airglow-focus-hider-x';
const BANNER_ID = 'airglow-focus-banner-x';
const HIDE_ATTR = 'data-airglow-x-hide';
let clockRaf = 0;
let observer: MutationObserver | null = null;
let active = false;
let disabledByUser = false;

const css = `
/* Hide the timeline feed content */
[data-testid="primaryColumn"] [aria-label*="timeline" i] {
  display: none !important;
}

/* Hide the entire right sidebar */
[data-testid="sidebarColumn"] {
  display: none !important;
}

/* Hide post confirmation toast */
[data-testid="toast"] {
  display: none !important;
}

/* Broad early hide: catch timeline before data-testid is hydrated */
html[${HIDE_ATTR}] main {
  visibility: hidden !important;
}

/* Motivational banner */
#${BANNER_ID} {
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
#${BANNER_ID} .afb-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.5px;
  margin: 0 0 12px;
  line-height: 1.2;
  color: #e2e4eb;
}
#${BANNER_ID} .afb-sub {
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
  if (document.getElementById(BANNER_ID)) return;
  const col = document.querySelector('[data-testid="primaryColumn"]');
  if (!col) return;
  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.innerHTML = `
    <div style="margin-bottom: 28px;">${CLOCK_SVG}</div>
    <p class="afb-title">Time to do great things</p>
    <p class="afb-sub">Your feed is hidden — stay focused on what matters.</p>
  `;
  col.appendChild(banner);
  if (!clockRaf) clockRaf = requestAnimationFrame(tickClock);
}

function removeBanner() {
  document.getElementById(BANNER_ID)?.remove();
  if (clockRaf) { cancelAnimationFrame(clockRaf); clockRaf = 0; }
}

function isHome() {
  return location.pathname === '/home' || location.pathname === '/home/';
}

function enable() {
  if (active || disabledByUser) return;
  active = true;
  document.documentElement.setAttribute(HIDE_ATTR, '');
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.documentElement.appendChild(style);
  }
  // Remove broad hide once targeted selectors are active
  const removeBroadHide = () => {
    if (!active) return;
    if (document.querySelector('[data-testid="primaryColumn"]')) {
      document.documentElement.removeAttribute(HIDE_ATTR);
    } else {
      requestAnimationFrame(removeBroadHide);
    }
  };
  requestAnimationFrame(removeBroadHide);
  injectBanner();
  if (!observer && document.documentElement) {
    observer = new MutationObserver(() => { if (active) injectBanner(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}

function disable() {
  if (!active) return;
  active = false;
  document.getElementById(STYLE_ID)?.remove();
  document.documentElement.removeAttribute(HIDE_ATTR);
  removeBanner();
  observer?.disconnect();
  observer = null;
}

function sync() {
  if (disabledByUser) { disable(); return; }
  if (isHome()) enable(); else disable();
}

// SPA navigation detection: userscripts run in an isolated world, so patching
// history.pushState here does NOT intercept the page's calls. Poll pathname instead.
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    sync();
  }
}, 200);
window.addEventListener('popstate', sync);

sync();

airglow.storage.get('focus_hider_sites').then((val: string | undefined) => {
  if (!val) return;
  try {
    const sites = JSON.parse(val);
    if (sites.x === false) {
      disabledByUser = true;
      disable();
    }
  } catch {}
});

})();
