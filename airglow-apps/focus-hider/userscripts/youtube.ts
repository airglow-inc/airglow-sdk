// Focus Hider — YouTube
// Hides videos and shorts on homepage, suggested videos on watch pages.
// @ts-ignore — airglow SDK injected at runtime
declare const airglow: any; // eslint-disable-line
export {};

;(function () {

const STYLE_ID = 'airglow-focus-hider-yt';
const BANNER_ID = 'airglow-focus-banner-yt';
let clockRaf = 0;
let observer: MutationObserver | null = null;
let disabledByUser = false;

const css = `
/* Homepage: hide video grid and shorts */
ytd-browse[page-subtype="home"] ytd-rich-grid-renderer,
ytd-browse[page-subtype="home"] ytd-rich-shelf-renderer,
ytd-browse[page-subtype="home"] ytd-reel-shelf-renderer,
ytd-browse[page-subtype="home"] ytd-rich-section-renderer {
  display: none !important;
}

/* Watch page: hide suggested videos sidebar content but preserve layout */
ytd-watch-flexy #secondary {
  visibility: hidden !important;
}

/* Sidebar: hide subscription channel entries (/@channel links) and show more/less */
ytd-guide-section-renderer ytd-guide-entry-renderer:has(a[href^="/@"]),
ytd-guide-section-renderer ytd-guide-collapsible-entry-renderer {
  display: none !important;
}

/* Motivational banner */
#${BANNER_ID} {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 32px;
  margin: 16px auto 0;
  max-width: 630px;
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

function isHome() {
  return location.pathname === '/' || location.pathname === '';
}

function injectBanner() {
  if (disabledByUser || !isHome() || document.getElementById(BANNER_ID)) return;
  const host = document.querySelector('ytd-browse[page-subtype="home"]');
  if (!host) return;
  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.innerHTML = `
    <div style="margin-bottom: 28px;">${CLOCK_SVG}</div>
    <p class="afb-title">Time to do great things</p>
    <p class="afb-sub">Your feed is hidden — stay focused on what matters.</p>
  `;
  host.appendChild(banner);
  if (!clockRaf) clockRaf = requestAnimationFrame(tickClock);
}

function removeBanner() {
  document.getElementById(BANNER_ID)?.remove();
  if (clockRaf) { cancelAnimationFrame(clockRaf); clockRaf = 0; }
}

const style = document.createElement('style');
style.id = STYLE_ID;
style.textContent = css;
(document.head || document.documentElement).appendChild(style);

function sync() {
  if (disabledByUser) return;
  if (isHome()) injectBanner(); else removeBanner();
}

// SPA nav detection — YouTube uses client-side navigation
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    sync();
  }
}, 200);
window.addEventListener('popstate', sync);

observer = new MutationObserver(() => sync());
if (document.documentElement) {
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

sync();

airglow.storage.get('focus_hider_sites').then((val: string | undefined) => {
  if (!val) return;
  try {
    const sites = JSON.parse(val);
    if (sites.youtube === false) {
      disabledByUser = true;
      style.remove();
      removeBanner();
      observer?.disconnect();
      observer = null;
    }
  } catch {}
});

})();
