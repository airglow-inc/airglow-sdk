// Finds page elements matching instruction-step targets and overlays a
// numbered ring around each. A "Hide instructions" pill at the top dismisses
// them. Overlays track their target on scroll/resize/DOM mutations.

export interface HighlightStep {
  action: string;
  target: string;
  value?: string;
}

interface Overlay {
  el: HTMLElement;
  target: Element;
}

const HIGHLIGHT_COLOR = '#e8a050';
const HIDE_BTN_ID = 'airglow-page-navigator-hide-btn';
const STYLE_ID = 'airglow-page-navigator-highlight-style';
const OVERLAY_MARK = 'data-airglow-pn-highlight';

let overlays: Overlay[] = [];
let currentSteps: HighlightStep[] | null = null;
let rafId: number | null = null;
let rescanTimer: number | null = null;
let observer: MutationObserver | null = null;
let hideBtn: HTMLButtonElement | null = null;

// ── Matching ──

function normalize(s: string): string {
  return s.replace(/[\s ]+/g, ' ').trim().toLowerCase();
}

function stripParens(s: string): string {
  return s.replace(/\s*\([^)]*\)/g, '').trim();
}

const CANDIDATE_SELECTOR =
  'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="switch"], [role="radio"], input, select, textarea, label, [aria-label], [data-tooltip], [tabindex]:not([tabindex="-1"])';

function isOurUi(el: Element): boolean {
  return !!el.closest(
    `#airglow-page-navigator-pill, [data-testid="page-navigator-panel"], [${OVERLAY_MARK}], #${HIDE_BTN_ID}`
  );
}

function findElement(rawLabel: string, taken: Set<Element>): Element | null {
  const targets = [normalize(rawLabel), normalize(stripParens(rawLabel))]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  if (!targets.length) return null;

  let bestEl: Element | null = null;
  let bestScore = 0;
  let bestTextLen = Infinity;

  const candidates = document.querySelectorAll(CANDIDATE_SELECTOR);
  for (const el of Array.from(candidates)) {
    if (taken.has(el)) continue;
    if (isOurUi(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;

    const texts: string[] = [];
    for (const attr of ['aria-label', 'title', 'placeholder', 'alt', 'data-tooltip']) {
      const v = el.getAttribute(attr);
      if (v) texts.push(normalize(v));
    }
    const innerText = ((el as HTMLElement).innerText || el.textContent || '').trim();
    if (innerText && innerText.length < 200) texts.push(normalize(innerText));

    let score = 0, textLen = Infinity;
    for (const target of targets) {
      for (const t of texts) {
        let s = 0;
        if (t === target) s = 100;
        else if (target.length >= 3 && t.includes(target)) s = 80 - Math.min(20, t.length - target.length);
        else if (t.length >= 3 && t.length <= 40 && target.includes(t)) s = 55;
        if (s > score) { score = s; textLen = t.length; }
      }
    }

    if (score === 0) continue;
    if (score > bestScore || (score === bestScore && textLen < bestTextLen)) {
      bestEl = el;
      bestScore = score;
      bestTextLen = textLen;
    }
  }

  return bestScore >= 55 ? bestEl : null;
}

// ── Overlay rendering ──

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes airglow-pn-pulse {
      0%, 100% { box-shadow: 0 0 8px rgba(232,160,80,0.55); }
      50%      { box-shadow: 0 0 20px rgba(232,160,80,0.95); }
    }
    [${OVERLAY_MARK}] {
      animation: airglow-pn-pulse 1.6s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
}

function positionOverlay(o: Overlay) {
  const r = o.target.getBoundingClientRect();
  o.el.style.left = (r.left - 3) + 'px';
  o.el.style.top = (r.top - 3) + 'px';
  o.el.style.width = (r.width + 6) + 'px';
  o.el.style.height = (r.height + 6) + 'px';
  // Hide if target is no longer visible
  const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
    && r.top < window.innerHeight && r.left < window.innerWidth;
  o.el.style.opacity = visible ? '1' : '0';
}

function addOverlay(target: Element, n: number) {
  const ring = document.createElement('div');
  ring.setAttribute(OVERLAY_MARK, '');
  ring.style.cssText = `
    position: fixed; pointer-events: none; z-index: 2147483646;
    border: 3px solid ${HIGHLIGHT_COLOR};
    border-radius: 6px;
    transition: opacity 0.15s ease-out;
  `;

  const badge = document.createElement('div');
  badge.style.cssText = `
    position: absolute; top: -11px; left: -11px;
    width: 22px; height: 22px; border-radius: 50%;
    background: ${HIGHLIGHT_COLOR}; color: #fff;
    font-size: 12px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    box-shadow: 0 2px 6px rgba(0,0,0,0.25);
  `;
  badge.textContent = String(n);
  ring.appendChild(badge);

  document.body.appendChild(ring);
  const o: Overlay = { el: ring, target };
  overlays.push(o);
  positionOverlay(o);
}

// ── Tracking & re-scanning ──

function startTracking() {
  if (rafId !== null) return;
  const tick = () => {
    for (const o of overlays) positionOverlay(o);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopTracking() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function recompute() {
  for (const o of overlays) o.el.remove();
  overlays = [];

  if (!currentSteps) return;

  const taken = new Set<Element>();
  let n = 0;
  for (const s of currentSteps) {
    n++;
    if (s.action === 'press') continue;
    const el = findElement(s.target, taken);
    if (!el) continue;
    taken.add(el);
    addOverlay(el, n);
  }
}

function startObserving() {
  if (observer) return;
  observer = new MutationObserver(() => {
    if (rescanTimer !== null) clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => { rescanTimer = null; recompute(); }, 250);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-expanded', 'class', 'hidden', 'style'],
  });
}

function stopObserving() {
  observer?.disconnect();
  observer = null;
  if (rescanTimer !== null) { clearTimeout(rescanTimer); rescanTimer = null; }
}

// ── Hide button ──

function ensureHideButton(): HTMLButtonElement {
  if (hideBtn && document.body.contains(hideBtn)) return hideBtn;
  const btn = document.createElement('button');
  btn.id = HIDE_BTN_ID;
  btn.type = 'button';
  btn.textContent = 'Hide instructions';
  btn.style.cssText = `
    position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647;
    background: #fff; border: 2px solid ${HIGHLIGHT_COLOR};
    color: #a05f1c; font-weight: 600; font-size: 14px;
    padding: 7px 18px; border-radius: 999px; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: none;
  `;
  btn.addEventListener('mouseenter', () => { btn.style.background = '#fdf2e4'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = '#fff'; });
  btn.addEventListener('click', () => clearHighlights());
  document.body.appendChild(btn);
  hideBtn = btn;
  return btn;
}

// ── Public API ──

export function applyHighlights(steps: HighlightStep[]) {
  injectStyle();
  currentSteps = steps;
  recompute();
  if (overlays.length === 0) {
    // Nothing matched — don't show the Hide button.
    currentSteps = null;
    return;
  }
  ensureHideButton().style.display = 'block';
  startTracking();
  startObserving();
}

export function clearHighlights() {
  for (const o of overlays) o.el.remove();
  overlays = [];
  currentSteps = null;
  stopTracking();
  stopObserving();
  if (hideBtn) hideBtn.style.display = 'none';
}
