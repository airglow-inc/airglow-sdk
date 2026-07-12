// App UI page composition, shared between the daemon's live /api/apps/<id>/ui
// route and the catalog prebuild (airglow-catalog scripts/build-apps.mjs).
// Keep this module dependency-free (no daemon imports) so the catalog build
// can import it standalone.

// A literal `</script>` inside an inline script (React DOM's dev build ships
// one in a string) terminates the tag early and the rest of the bundle
// renders as page text. esbuild escaped this in its output; Bun.build does
// not, so escape at embed time. `</script` can only legally occur inside JS
// strings/comments, where the backslash is a no-op escape — same trick
// esbuild and Vite use.
export function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script');
}

// Base CSS prepended to every UI HTML page so apps inherit Inter / JetBrains
// Mono and a basic reset. Kept in sync with extension/lib/airglow-base.css.
// fontsBase: '/api/fonts' when the daemon serves the page; an absolute URL for
// prebuilt pages hosted off-origin (Blob), where a relative path would 404 and
// silently fall back to system fonts.
export function airglowBaseCss(fontsBase = '/api/fonts'): string {
  return `
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; font-display: swap; src: url('${fontsBase}/inter-variable.woff2') format('woff2-variations'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 100 800; font-display: swap; src: url('${fontsBase}/jetbrains-mono-variable.woff2') format('woff2-variations'); }
*, *::before, *::after { box-sizing: border-box; }
body { font-family: var(--font-sans, 'Inter', system-ui, sans-serif); }
button, input, textarea, select { font-family: inherit; }
code, kbd, samp, pre { font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace); }
`;
}

// Embedded app UIs report their content height to the dashboard so the iframe
// can size to fit and scroll with the page (rather than the dashboard pinning a
// fixed-viewport iframe with its own internal scroll). Guarded to the embedded
// case; deduped so resizing the iframe doesn't feed back into a resize loop.
export const AIRGLOW_EMBED_RESIZE_JS = `(function(){
  if (window.parent === window) return;
  var last = 0;
  function report(){
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (h !== last) { last = h; parent.postMessage({ _airglow_height: h }, '*'); }
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(report);
    ro.observe(document.documentElement);
    ro.observe(document.body);
  }
  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  report();

  // Auto-height embed ('_embed=fit'): the iframe is sized to its content, so it
  // has no scroll of its own and the dashboard page is the scroller. Cross-origin
  // iframes don't reliably chain wheel scrolling to the parent — and a sub-pixel
  // height mismatch latches the gesture inside the iframe (the "stuck scroll") —
  // so forward wheel to the dashboard, unless an inner scroll container can
  // consume it in that direction (then let it scroll natively).
  if (/[?&]_embed=fit(&|$)/.test(location.search)) {
    window.addEventListener('wheel', function(e){
      var node = e.target;
      while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
        var st = getComputedStyle(node);
        if (e.deltaY && (st.overflowY === 'auto' || st.overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
          var atTop = node.scrollTop <= 0;
          var atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
          if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
        }
        if (e.deltaX && (st.overflowX === 'auto' || st.overflowX === 'scroll') && node.scrollWidth > node.clientWidth) {
          var atLeft = node.scrollLeft <= 0;
          var atRight = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
          if ((e.deltaX < 0 && !atLeft) || (e.deltaX > 0 && !atRight)) return;
        }
        node = node.parentNode;
      }
      e.preventDefault();
      parent.postMessage({ _airglow_wheel: { x: e.deltaX, y: e.deltaY, mode: e.deltaMode } }, '*');
    }, { passive: false });
  }
})();`;

export interface ComposeUiHtmlOptions {
  appId: string;
  // SDK code from buildSdkCode(appId, 'app_ui').
  sdkCode: string;
  // The bundled (iife) UI entry.
  appCode: string;
  css: string;
  // Set for the shared default-ui fallback, which needs the app id injected.
  appIdInject?: boolean;
  fontsBase?: string;
}

// The page reads its params (app, page, _embed) from location.search at
// runtime, so the same HTML works daemon-served and as a prebuilt static file.
export function composeUiHtml(opts: ComposeUiHtmlOptions): string {
  const appIdInject = opts.appIdInject
    ? `<script>window.__airglow_app_id=${JSON.stringify(opts.appId)};<\/script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${opts.appId}</title><style>${airglowBaseCss(opts.fontsBase)}</style><style>${opts.css}</style></head>
<body><div id="root"></div>
${appIdInject}<script>${escapeInlineScript(opts.sdkCode)}<\/script>
<script>window.__airglow_params = Object.fromEntries(new URLSearchParams(location.search));<\/script>
<script>${escapeInlineScript(opts.appCode)}<\/script>
<script>${AIRGLOW_EMBED_RESIZE_JS}<\/script>
</body></html>`;
}
