import ICON_SVG from './branding/icon.svg?raw';

const WARN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;

// Font family used by every edge-button surface. Backed by an @font-face
// pointing at the extension's bundled Inter so width is consistent across sites.
const AIRGLOW_FONT = '"Airglow Inter", sans-serif';

function ensureAirglowFont() {
  if (document.getElementById('__airglow_font')) return;
  const style = document.createElement('style');
  style.id = '__airglow_font';
  // textContent (not innerHTML) so Trusted Types policies don't intercept.
  style.textContent =
    '@font-face { font-family: "Airglow Inter"; font-style: normal;' +
    ' font-weight: 100 900; font-display: swap;' +
    ' src: url("' + chrome.runtime.getURL('fonts/inter-variable.woff2') + '") format("woff2-variations"); }';
  (document.head || document.documentElement).appendChild(style);
}

interface PageApp {
  id: string;
  name: string;
  disabled: boolean;
  hasError?: boolean;
}

interface PopupOpts {
  position?: { top?: string; bottom?: string; transform?: string };
  appId?: string; // if set, query by appId instead of URL
  onApps?: (apps: PageApp[]) => void; // called when apps are fetched
}

function createPopup(opts?: PopupOpts): { el: HTMLElement; show: () => void; hide: () => void; onHideAll?: () => void } {
  ensureAirglowFont();
  const pos = opts?.position ?? { top: '50%', transform: 'translateY(-50%)' };
  const popup = document.createElement('div');
  popup.setAttribute('data-testid', 'airglow-edge-popup');
  Object.assign(popup.style, {
    position: 'fixed',
    right: '48px',
    top: pos.top ?? '',
    bottom: pos.bottom ?? '',
    transform: pos.transform ?? '',
    background: '#f9f8f3',
    borderRadius: '12px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06)',
    padding: '12px 14px',
    zIndex: '2147483647',
    fontFamily: AIRGLOW_FONT,
    fontSize: '14px',
    color: '#1a1a1a',
    minWidth: '180px',
    display: 'none',
    opacity: '0',
    transition: 'opacity 0.12s ease-out',
  });

  document.body.appendChild(popup);

  let needsRefresh = false;
  const result: ReturnType<typeof createPopup> = { el: popup, show, hide };

  function renderFooter() {
    const footer = document.createElement('div');
    footer.setAttribute('data-testid', 'popup-footer');
    Object.assign(footer.style, {
      marginTop: '6px',
      paddingTop: '6px',
      borderTop: '1px solid rgba(0,0,0,0.08)',
      display: 'flex',
      alignItems: 'center',
    });

    if (needsRefresh) {
      Object.assign(footer.style, { justifyContent: 'space-between', gap: '8px', paddingTop: '6px', marginTop: '6px' });

      const text = document.createElement('span');
      text.textContent = 'Refresh to apply';
      Object.assign(text.style, { fontSize: '12px', color: '#888', whiteSpace: 'nowrap' });

      const btn = document.createElement('button');
      btn.textContent = 'Refresh';
      Object.assign(btn.style, {
        fontSize: '12px', padding: '3px 8px', borderRadius: '6px',
        border: '1px solid rgba(0,0,0,0.12)', background: '#fff',
        cursor: 'pointer', color: '#0D3B6E', fontWeight: '500', flexShrink: '0', fontFamily: 'inherit',
      });
      btn.addEventListener('click', (e) => { e.stopPropagation(); location.reload(); });

      footer.appendChild(text);
      footer.appendChild(btn);
    } else {
      const hideBtn = document.createElement('button');
      hideBtn.textContent = 'Hide';
      hideBtn.setAttribute('data-testid', 'airglow-hide-button');
      hideBtn.style.cssText = 'font-size:12px; padding:3px 8px; border-radius:6px; border:1px solid rgba(0,0,0,0.12); background:#fff; cursor:pointer; font-family:inherit; font-weight:500;';
      hideBtn.style.setProperty('color', '#0D3B6E', 'important');
      hideBtn.addEventListener('mouseenter', () => { hideBtn.style.borderColor = 'rgba(0,0,0,0.2)'; });
      hideBtn.addEventListener('mouseleave', () => { hideBtn.style.borderColor = 'rgba(0,0,0,0.12)'; });
      hideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hide();
        result.onHideAll?.();
      });
      footer.appendChild(hideBtn);
    }

    return footer;
  }

  function render(apps: PageApp[]) {
    if (apps.length === 0) {
      popup.innerHTML = '';
      const msg = document.createElement('div');
      msg.style.cssText = 'color:#888; font-size:13px;';
      msg.textContent = 'No apps on this page';
      popup.appendChild(msg);
      popup.appendChild(renderFooter());
      return;
    }

    popup.innerHTML = '';

    for (const app of apps) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 0',
        gap: '12px',
      });

      const labelWrap = document.createElement('div');
      Object.assign(labelWrap.style, { display: 'flex', alignItems: 'center', gap: '5px' });

      if (app.hasError) {
        const warn = document.createElement('a');
        warn.href = '#';
        warn.innerHTML = WARN_SVG;
        Object.assign(warn.style, { color: '#e53e3e', display: 'flex', alignItems: 'center', flexShrink: '0', cursor: 'pointer', transition: 'transform 0.12s ease-out, filter 0.12s' });
        warn.title = 'View error logs';
        warn.addEventListener('mouseenter', () => { warn.style.transform = 'scale(1.25)'; warn.style.filter = 'brightness(1.3)'; });
        warn.addEventListener('mouseleave', () => { warn.style.transform = 'scale(1)'; warn.style.filter = ''; });
        warn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          chrome.runtime.sendMessage({ type: 'airglow:open-dashboard', page: 'logs' });
        });
        labelWrap.appendChild(warn);
      }

      const label = document.createElement('a');
      label.textContent = app.name;
      label.href = '#';
      Object.assign(label.style, {
        fontSize: '14px',
        color: app.disabled ? '#999' : '#1a1a1a',
        whiteSpace: 'nowrap',
        textDecoration: 'none',
        cursor: 'pointer',
      });
      label.addEventListener('mouseenter', () => { label.style.textDecoration = 'underline'; });
      label.addEventListener('mouseleave', () => { label.style.textDecoration = 'none'; });
      label.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'airglow:open-app', appId: app.id });
      });
      labelWrap.appendChild(label);

      const toggle = document.createElement('button');
      Object.assign(toggle.style, {
        width: '36px',
        height: '20px',
        borderRadius: '10px',
        border: 'none',
        cursor: 'pointer',
        position: 'relative',
        background: app.disabled ? '#ddd' : '#0D3B6E',
        transition: 'background 0.15s',
        flexShrink: '0',
      });

      const knob = document.createElement('div');
      Object.assign(knob.style, {
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#fff',
        position: 'absolute',
        top: '2px',
        left: app.disabled ? '2px' : '18px',
        transition: 'left 0.15s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      });
      toggle.appendChild(knob);

      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'airglow:toggle-app', appId: app.id }, (res) => {
          if (res?.ok) {
            app.disabled = res.disabled;
            label.style.color = app.disabled ? '#999' : '#1a1a1a';
            toggle.style.background = app.disabled ? '#ddd' : '#0D3B6E';
            knob.style.left = app.disabled ? '2px' : '18px';
            needsRefresh = true;
            showRefreshHint();
          }
        });
      });

      row.appendChild(labelWrap);
      row.appendChild(toggle);
      popup.appendChild(row);
    }

    popup.appendChild(renderFooter());
  }

  function showRefreshHint() {
    needsRefresh = true;
    const oldFooter = popup.querySelector('[data-testid="popup-footer"]');
    if (oldFooter) {
      oldFooter.replaceWith(renderFooter());
    }
  }

  function show() {
    popup.style.display = 'block';
    requestAnimationFrame(() => { popup.style.opacity = '1'; });
    // Fetch apps for current page (by appId for app-shell, by URL otherwise)
    const msg: any = { type: 'airglow:get-page-apps', url: location.href };
    if (opts?.appId) msg.appId = opts.appId;
    chrome.runtime.sendMessage(msg, (res) => {
      if (res?.apps) {
        render(res.apps);
        opts?.onApps?.(res.apps);
      }
    });
  }

  function hide() {
    popup.style.opacity = '0';
    setTimeout(() => { popup.style.display = 'none'; }, 120);
  }

  return result;
}

/**
 * Edge-peek button for normal web pages.
 * Reveals progressively as mouse approaches the right edge.
 */
export function createEdgeButton() {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => createEdgeButton());
    return;
  }

  const W = 40, H = 56, ICON_SIZE = 22;
  const FULLY_HIDDEN = W + 2, PEEK = W * 0.88, PARTIAL = W * 0.22;
  const OUTER = 0.10, INNER = 0.05;

  const btn = document.createElement('div');
  btn.setAttribute('data-testid', 'airglow-edge-button');
  btn.innerHTML = `
    <div style="
      width: ${W}px; height: ${H}px;
      border-radius: 14px 0 0 14px;
      background: #f9f8f3;
      box-shadow: -2px 0 10px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.05);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
    ">
      <div data-airglow-icon style="width: ${ICON_SIZE}px; height: ${ICON_SIZE}px; border-radius: 4px; overflow: hidden;">${ICON_SVG}</div>
    </div>`;

  // Clip container — only the visible portion of the button receives events.
  // Without this, the 40px-wide button blocks clicks near the right edge.
  const PAD = 16; // extra space left/top/bottom for shadow bleed
  const clip = document.createElement('div');
  Object.assign(clip.style, {
    position: 'fixed',
    right: '0px',
    top: '50%',
    transform: 'translateY(-50%)',
    width: `${W + PAD}px`,
    height: `${H + PAD * 2}px`,
    overflow: 'hidden',
    zIndex: '2147483647',
    pointerEvents: 'none',
  });

  Object.assign(btn.style, {
    marginLeft: `${PAD}px`,
    marginTop: `${PAD}px`,
    transform: `translateX(${FULLY_HIDDEN}px)`,
    transition: 'transform 0.18s ease-out',
  });

  clip.appendChild(btn);
  document.body.appendChild(clip);

  // Popup
  const iconEl = btn.querySelector('[data-airglow-icon]') as HTMLElement;
  const popup = createPopup({
    onApps(apps) {
      const hasError = apps.some(a => a.hasError);
      iconEl.style.boxShadow = hasError ? '0 0 0 2px #e53e3e' : '';
    },
  });
  // Clear the outline as soon as the user reads /logs — the next hover would
  // recompute it anyway, but doing it live avoids stale red on idle tabs.
  chrome.storage.onChanged.addListener((changes) => {
    if ('__logs_last_seen_ts' in changes) iconEl.style.boxShadow = '';
  });
  const { el: popupEl, show: showPopup, hide: hidePopup } = popup;

  let hovering = false;
  let popupVisible = false;
  let hidden = false;
  let hideTimeout: ReturnType<typeof setTimeout> | null = null;
  let curOffset = FULLY_HIDDEN;

  popup.onHideAll = () => {
    hidden = true;
    hovering = false;
    popupVisible = false;
    setOffset(FULLY_HIDDEN);
  };

  function setOffset(px: number) {
    if (px === curOffset) return;
    curOffset = px;
    btn.style.transform = `translateX(${px}px)`;
    clip.style.pointerEvents = px < FULLY_HIDDEN ? 'auto' : 'none';
  }

  function onMouseMove(e: MouseEvent) {
    if (hidden || hovering || popupVisible) return;
    const vw = window.innerWidth;
    const frac = (vw - e.clientX) / vw;

    if (frac > OUTER) {
      setOffset(FULLY_HIDDEN);
      return;
    }

    const t = Math.min(1, (OUTER - frac) / (OUTER - INNER));
    setOffset(PEEK + (PARTIAL - PEEK) * t);
  }

  // mouseout with null relatedTarget fires reliably when cursor leaves
  // the viewport — even through screen edges where mouseleave doesn't fire
  function onMouseOut(e: MouseEvent) {
    if (e.relatedTarget) return;
    hovering = false;
    popupVisible = false;
    if (hideTimeout) clearTimeout(hideTimeout);
    hidePopup();
    setOffset(FULLY_HIDDEN);
  }

  function scheduleHide() {
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (!hovering && !popupVisible) {
        hidePopup();
        setOffset(FULLY_HIDDEN);
      }
    }, 200);
  }

  clip.addEventListener('mouseenter', () => {
    hovering = true;
    if (hideTimeout) clearTimeout(hideTimeout);
    setOffset(0);
    showPopup();
  });
  clip.addEventListener('mouseleave', () => {
    hovering = false;
    scheduleHide();
  });

  popupEl.addEventListener('mouseenter', () => {
    popupVisible = true;
    if (hideTimeout) clearTimeout(hideTimeout);
  });
  popupEl.addEventListener('mouseleave', () => {
    popupVisible = false;
    scheduleHide();
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'airglow:open-dashboard' });
  });

  document.addEventListener('mousemove', onMouseMove, { passive: true });
  document.addEventListener('mouseout', onMouseOut);
}

/**
 * Persistent always-visible button for extension pages (app-shell).
 * Fullscreen iframes block parent mousemove, so edge-peek doesn't work.
 */
export function createPersistentButton() {
  if (new URLSearchParams(location.search).get('edge') === '0') return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => createPersistentButton());
    return;
  }

  const W = 40, H = 56, ICON_SIZE = 22;

  // Extract appId from app-shell URL params
  const appId = new URLSearchParams(location.search).get('app') || undefined;

  const btn = document.createElement('div');
  btn.setAttribute('data-testid', 'airglow-edge-button');
  btn.innerHTML = `
    <div style="
      width: ${W}px; height: ${H}px;
      border-radius: 14px 0 0 14px;
      background: #f9f8f3;
      box-shadow: -2px 0 10px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.05);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.15s;
    ">
      <div data-airglow-icon style="width: ${ICON_SIZE}px; height: ${ICON_SIZE}px; border-radius: 4px; overflow: hidden;">${ICON_SVG}</div>
    </div>`;

  Object.assign(btn.style, {
    position: 'fixed',
    right: '0px',
    bottom: '20vh',
    zIndex: '2147483647',
  });

  document.body.appendChild(btn);

  // Popup positioned near the persistent button
  const persistentIconEl = btn.querySelector('[data-airglow-icon]') as HTMLElement;
  const popup = createPopup({
    position: { bottom: '20vh' },
    appId,
    onApps(apps) {
      const hasError = apps.some(a => a.hasError);
      persistentIconEl.style.outline = hasError ? '2px solid #e53e3e' : '';
      persistentIconEl.style.outlineOffset = hasError ? '1px' : '';
    },
  });
  chrome.storage.onChanged.addListener((changes) => {
    if ('__logs_last_seen_ts' in changes) {
      persistentIconEl.style.outline = '';
      persistentIconEl.style.outlineOffset = '';
    }
  });
  const { el: popupEl, show: showPopup, hide: hidePopup } = popup;

  let hovering = false;
  let popupVisible = false;
  let hideTimeout: ReturnType<typeof setTimeout> | null = null;

  popup.onHideAll = () => {
    hovering = false;
    popupVisible = false;
    btn.style.display = 'none';
  };

  function scheduleHide() {
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (!hovering && !popupVisible) {
        hidePopup();
        const inner = btn.firstElementChild as HTMLElement;
        inner.style.opacity = '0.5';
      }
    }, 200);
  }

  btn.addEventListener('mouseenter', () => {
    hovering = true;
    if (hideTimeout) clearTimeout(hideTimeout);
    const inner = btn.firstElementChild as HTMLElement;
    inner.style.opacity = '1';
    showPopup();
  });
  btn.addEventListener('mouseleave', () => {
    hovering = false;
    scheduleHide();
  });

  popupEl.addEventListener('mouseenter', () => {
    popupVisible = true;
    if (hideTimeout) clearTimeout(hideTimeout);
  });
  popupEl.addEventListener('mouseleave', () => {
    popupVisible = false;
    scheduleHide();
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'airglow:open-dashboard' });
  });
}
