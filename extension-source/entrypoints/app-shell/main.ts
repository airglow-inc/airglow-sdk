// App shell — hosts app UI in a sandboxed iframe.
// The shell has chrome.* access and bridges SDK calls from the sandbox via postMessage.
//
// Two UI delivery paths:
//   - Local apps: iframe loads ${devServer}/api/apps/${id}/ui directly (same-
//     origin trust, dev server serves the page).
//   - Cloud apps: iframe loads chrome-extension://.../app-ui-sandbox.html
//     with a nonce, app-shell fetches the UI bundle as text, posts it in.
//     Keeps the cloud bundle in an extension-CSP sandbox we control.

import '../../lib/airglow-base.css';
import { logger } from '../../lib/logger';
import { buildSdkCode } from '../../lib/airglow-sdk';

const APP_SOURCES_KEY = '__app_sources';
const APP_MANIFESTS_KEY = '__app_manifests';
const DEV_SERVER_ONLINE_KEY = '__dev_server_online';
const UI_LOAD_TIMEOUT_MS = 12000;
const UI_BUNDLE_FETCH_TIMEOUT_MS = 8000;
const AUTO_RETRY_DELAYS_MS = [1000, 3000];
const UI_BUNDLE_RETRY_DELAYS_MS = [500, 1500];
type AppSource = { url: string; type: 'local' | 'cloud' };

const params = new URLSearchParams(window.location.search);
const appId = params.get('app');

if (!appId) {
  document.getElementById('loading')!.textContent = 'Missing app parameter';
} else {
  trackUiPageOpened(appId);
  loadApp(appId);
}

function trackUiPageOpened(appId: string) {
  chrome.runtime.sendMessage({
    type: 'airglow:track-ui-page-opened',
    appId,
  }, () => { void chrome.runtime.lastError; });
}

function renderOfflineMessage(appId: string) {
  // Vanilla mirror of the dashboard's classic "Dev server offline" card —
  // centered, error-tinted, big TriangleAlert in a circle, bold title,
  // outlined Retry button. The app UI bundle is served by the dev server,
  // so this page can't load without it; userscripts run from cache and are
  // unaffected.
  void appId;
  document.body.innerHTML = '';

  // Inline SVGs so we don't depend on any icon library inside app-shell.
  const triangleSvg = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  const refreshSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>';

  const ERROR = '#b91c1c';
  const ERROR_BG_8 = 'color-mix(in srgb, #b91c1c 8%, #ffffff)';
  const ERROR_BG_18 = 'color-mix(in srgb, #b91c1c 18%, #ffffff)';
  const BORDER_RED = 'color-mix(in srgb, #b91c1c 30%, #e7e5e4)';
  const FG = '#1c1917';
  const FG_SECONDARY = '#57534e';
  const BG_PAGE = '#f5f5f4';
  const CODE_BG = '#fafaf9';
  // Body, <code>, and <button> all inherit from airglow-base.css — no need
  // to repeat font-family on every block here.
  const wrap = document.createElement('div');
  wrap.id = 'airglow-app-offline';
  wrap.style.cssText = `position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:${BG_PAGE};color:${FG};`;
  wrap.innerHTML = `
    <div style="text-align:center;max-width:560px;padding:36px;border-radius:12px;border:1px solid ${BORDER_RED};background:${ERROR_BG_8}">
      <div style="display:flex;justify-content:center;margin-bottom:18px">
        <div style="display:inline-flex;padding:18px;border-radius:9999px;background:${ERROR_BG_18};color:${ERROR}">
          ${triangleSvg}
        </div>
      </div>
      <div style="font-size:28px;font-weight:700;line-height:1.2;margin-bottom:12px;color:${FG}">Dev server is offline</div>
      <p style="font-size:18px;line-height:1.55;color:${FG_SECONDARY};margin:0">
        Run <code style="background:${CODE_BG};padding:2px 8px;border-radius:4px;color:${FG};font-size:17px">pnpm airglow dev</code>
        to start the dev server and load this app.
      </p>
      <button id="airglow-offline-retry" type="button" style="margin-top:24px;height:44px;padding:0 22px;border:1px solid ${ERROR};color:${ERROR};background:transparent;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:10px">
        ${refreshSvg}<span>Retry</span>
      </button>
    </div>
  `;
  document.body.appendChild(wrap);
  document.getElementById('airglow-offline-retry')?.addEventListener('click', () => location.reload());

  // Auto-reload when the background flips devServerOnline → true so the user
  // doesn't have to click Retry once `pnpm airglow dev` comes back.
  const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (DEV_SERVER_ONLINE_KEY in changes && changes[DEV_SERVER_ONLINE_KEY].newValue === true) {
      chrome.storage.local.onChanged.removeListener(listener);
      location.reload();
    }
  };
  chrome.storage.local.onChanged.addListener(listener);
}

/**
 * Wait for the background to populate __app_sources with this app's source.
 * Retries a few times since background discovery may not have completed yet.
 */
async function loadApp(appId: string) {
  // Fast path: if the dev server is offline AND this app is local-only, skip
  // the 12s iframe load wait. Cloud apps don't need the dev server, so the
  // offline message only applies when no source can serve the app.
  const onlineCheck = await chrome.storage.local.get([DEV_SERVER_ONLINE_KEY, APP_SOURCES_KEY]);
  const sourceMap = (onlineCheck[APP_SOURCES_KEY] || {}) as Record<string, AppSource>;
  const knownSource = sourceMap[appId];
  if (onlineCheck[DEV_SERVER_ONLINE_KEY] === false && (!knownSource || knownSource.type === 'local')) {
    renderOfflineMessage(appId);
    return;
  }

  if (knownSource?.url) {
    mountApp(appId, knownSource);
    return;
  }

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
    const result = await chrome.storage.local.get(APP_SOURCES_KEY);
    const refreshed = (result[APP_SOURCES_KEY] || {}) as Record<string, AppSource>;
    const source = refreshed[appId];
    if (source?.url) {
      mountApp(appId, source);
      return;
    }
  }

  logger.warn('airglow', `no source registered for app '${appId}' after ${maxAttempts} attempts`);
  document.getElementById('loading')!.textContent = `App '${appId}' not found. Is an app source reachable?`;
}

function mountApp(appId: string, source: AppSource) {
  const baseUrl = source.url.replace(/\/+$/, '');
  let iframe: HTMLIFrameElement | null = null;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  let loadAttempt = 0;
  let runtimeCrashVisible = false;
  let pendingSandboxPayload: { sdk: string; code: string } | null = null;
  let sandboxNonce = '';

  // Set tab title from cached manifests populated by the background loader.
  chrome.storage.local.get(APP_MANIFESTS_KEY).then((result) => {
    const manifests = Array.isArray(result[APP_MANIFESTS_KEY]) ? result[APP_MANIFESTS_KEY] : [];
    const manifest = manifests.find((m: any) => m?.id === appId);
    if (manifest?.name) {
      document.title = manifest.name;
    }
  }).catch((error) => {
    logger.warn('airglow', `cached manifest title lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  function buildUiUrl(cacheBust = false) {
    const uiParams = new URLSearchParams(params);
    if (cacheBust) uiParams.set('_airglow_reload', String(Date.now()));
    return `${baseUrl}/api/apps/${appId}/ui?${uiParams.toString()}`;
  }
  function buildUiBundleUrl(cacheBust = false) {
    const uiParams = new URLSearchParams();
    if (cacheBust) uiParams.set('_airglow_reload', String(Date.now()));
    const qs = uiParams.toString();
    return `${baseUrl}/api/apps/${appId}/ui-bundle${qs ? `?${qs}` : ''}`;
  }
  function buildSandboxUrl(cacheBust = false) {
    const sandboxParams = new URLSearchParams(params);
    sandboxParams.set('app', appId);
    sandboxParams.set('nonce', sandboxNonce);
    if (cacheBust) sandboxParams.set('_airglow_reload', String(Date.now()));
    return chrome.runtime.getURL(`app-ui-sandbox.html?${sandboxParams.toString()}`);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function shouldRetryHttpStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  }

  async function fetchUiBundle(url: string): Promise<Response> {
    let lastError = '';
    for (let attempt = 0; attempt <= UI_BUNDLE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(UI_BUNDLE_FETCH_TIMEOUT_MS) });
        if (!res.ok && shouldRetryHttpStatus(res.status) && attempt < UI_BUNDLE_RETRY_DELAYS_MS.length) {
          lastError = `UI bundle request failed with HTTP ${res.status}`;
          await sleep(UI_BUNDLE_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        return res;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < UI_BUNDLE_RETRY_DELAYS_MS.length) {
          await sleep(UI_BUNDLE_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new Error(`UI bundle request failed after ${UI_BUNDLE_RETRY_DELAYS_MS.length + 1} attempts: ${lastError}`);
      }
    }
    throw new Error(`UI bundle request failed: ${lastError}`);
  }
  function setLoading(message: string) {
    let loading = document.getElementById('loading');
    if (!loading) {
      loading = document.createElement('div');
      loading.id = 'loading';
      document.body.appendChild(loading);
    }
    loading.textContent = message;
  }

  function clearLoadTimer() {
    if (!loadTimer) return;
    clearTimeout(loadTimer);
    loadTimer = null;
  }

  function removeCrashOverlay() {
    document.getElementById('airglow-app-crash')?.remove();
    runtimeCrashVisible = false;
  }

  function formatErrorDetail(error: AppRuntimeError) {
    const parts = [
      error.name ? `${error.name}: ${error.message}` : error.message,
      error.filename ? `${error.filename}:${error.lineno ?? 0}:${error.colno ?? 0}` : '',
      error.stack || '',
    ].filter(Boolean);
    return parts.join('\n\n');
  }

  function showCrashOverlay(title: string, message: string, error?: AppRuntimeError) {
    runtimeCrashVisible = true;
    clearLoadTimer();

    const existing = document.getElementById('airglow-app-crash');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'airglow-app-crash';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:24px',
      'background:#f5f5f4',
      'color:#1c1917',
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    ].join(';');

    const detail = error ? formatErrorDetail(error) : '';
    overlay.innerHTML = `
      <div style="width:min(640px,100%);border:1px solid #e7e5e4;border-radius:8px;background:#fff;padding:20px;box-shadow:0 12px 32px rgba(28,25,23,.12)">
        <div style="font-size:13px;color:#78716c;margin-bottom:6px">Airglow app crashed</div>
        <div style="font-size:20px;font-weight:650;line-height:1.25;margin-bottom:8px">${escapeHtml(title)}</div>
        <div style="font-size:14px;line-height:1.5;color:#57534e;margin-bottom:16px">${escapeHtml(message)}</div>
        ${detail ? `<pre style="max-height:220px;overflow:auto;white-space:pre-wrap;background:#fafaf9;border:1px solid #e7e5e4;border-radius:6px;padding:12px;font-size:12px;line-height:1.45;color:#44403c;margin-bottom:16px">${escapeHtml(detail)}</pre>` : ''}
        <div style="display:flex;gap:8px;align-items:center">
          <button id="airglow-reload-app" style="height:36px;padding:0 14px;border:0;border-radius:999px;background:#1c1917;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Reload app</button>
          <button id="airglow-reload-extension" style="height:36px;padding:0 14px;border:1px solid #d6d3d1;border-radius:999px;background:#fff;color:#44403c;font-size:14px;font-weight:600;cursor:pointer">Reload extension</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById('airglow-reload-app')?.addEventListener('click', () => reloadIframe(true));
    document.getElementById('airglow-reload-extension')?.addEventListener('click', () => chrome.runtime.reload());
  }

  function scheduleLoadTimeout() {
    clearLoadTimer();
    loadTimer = setTimeout(() => {
      const retryDelay = AUTO_RETRY_DELAYS_MS[loadAttempt];
      if (retryDelay !== undefined) {
        loadAttempt++;
        setLoading(`App did not load. Retrying ${loadAttempt}/${AUTO_RETRY_DELAYS_MS.length}...`);
        window.setTimeout(() => reloadIframe(true), retryDelay);
        return;
      }

      showCrashOverlay(
        `App '${appId}' did not finish loading`,
        'The UI iframe did not fire a load event. This is usually a dev server, network, or bundle problem. Reloading the app iframe is enough; you should not need to restart the whole extension.',
      );
    }, UI_LOAD_TIMEOUT_MS);
  }

  function reloadIframe(cacheBust = false) {
    removeCrashOverlay();
    setLoading('Loading...');
    if (!iframe) return;
    if (source.type === 'cloud') {
      clearLoadTimer();
      reloadBundledIframe(cacheBust).catch((error) => {
        showCrashOverlay(
          `App '${appId}' failed to load`,
          error instanceof Error ? error.message : String(error),
        );
      });
      return;
    }
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    iframe.src = buildUiUrl(cacheBust);
    scheduleLoadTimeout();
  }

  async function reloadBundledIframe(cacheBust = false) {
    if (!iframe) return;
    const res = await fetchUiBundle(buildUiBundleUrl(cacheBust));
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) detail = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
      } catch {}
      throw new Error(`UI bundle request failed: ${detail}`);
    }

    sandboxNonce = crypto.randomUUID();
    pendingSandboxPayload = {
      sdk: buildSdkCode(appId, 'app_ui'),
      code: await res.text(),
    };

    iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
    scheduleLoadTimeout();
    iframe.src = buildSandboxUrl(cacheBust);
  }

  // Bridge all SDK calls and runtime crash notifications from sandbox iframe.
  // App-shell stamps _appId — background validates via sender.url (?app= param).
  window.addEventListener('message', (e) => {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const sourceWindow = e.source;
    const data = e.data;
    if (data?._airglow_app_error && data.appId === appId) {
      if (!runtimeCrashVisible) {
        showCrashOverlay(
          `App '${appId}' hit an unhandled error`,
          'The app iframe is still isolated. You can reload only this app without restarting the extension.',
          data,
        );
      }
      return;
    }
    if (!data?._airglow) return;

    const msg = { ...data, _appId: appId };
    chrome.runtime.sendMessage(msg, (response: any) => {
      const payload = chrome.runtime.lastError
        ? {
            error: chrome.runtime.lastError.message || 'Chrome runtime message failed',
            code: 'CHROME_RUNTIME_ERROR',
          }
        : response || {};
      sourceWindow?.postMessage(
        { _airglow_response: true, _callId: data._callId, ...payload },
        '*',
      );
    });
  });

  // Create sandboxed iframe that loads the app UI
  iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:none;';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');

  iframe.onload = () => {
    loadAttempt = 0;
    clearLoadTimer();
    document.getElementById('loading')?.remove();
    // Cloud-app sandbox handshake: hand off the SDK + bundle now that the
    // iframe is ready to receive postMessage. The sandbox validates the nonce
    // and evals via `new Function()` — no `?app=` URL trust, just the nonce.
    if (pendingSandboxPayload && iframe?.contentWindow) {
      iframe.contentWindow.postMessage({
        type: 'airglow:ui:run',
        appId,
        nonce: sandboxNonce,
        ...pendingSandboxPayload,
      }, '*');
      pendingSandboxPayload = null;
    }
  };
  iframe.onerror = () => {
    showCrashOverlay(
      `App '${appId}' failed to load`,
      'The browser reported an iframe load error. Reloading this app iframe should recover after a transient server or network issue.',
    );
  };

  document.body.appendChild(iframe);
  reloadIframe(false);
}


type AppRuntimeError = {
  kind?: string;
  message?: string;
  name?: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
};

function escapeHtml(value: string | undefined) {
  const div = document.createElement('div');
  div.textContent = value || '';
  return div.innerHTML;
}
