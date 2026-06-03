// App shell — hosts app UI in a sandboxed iframe.
// The shell has chrome.* access and bridges SDK calls from the sandbox via postMessage.

// Shared fonts + reset + form-control inheritance. Imported here (not via a
// <link> in index.html) so WXT bundles it into the page and serves the fonts
// from the extension package without an extra network hop.
import '../../lib/airglow-base.css';
import { createPersistentButton } from '../../lib/edge-button';
import { normalizeUserEmail, requiresUserEmail, sha256Email, USER_EMAIL_KEY } from '../../lib/airglow-identity';
import { runtimeConfig } from '../../lib/runtime-config';
import { logger } from '../../lib/logger';

const APP_SOURCES_KEY = '__app_sources';
const APP_MANIFESTS_KEY = '__app_manifests';
const DEV_SERVER_ONLINE_KEY = '__dev_server_online';
const UI_LOAD_TIMEOUT_MS = 12000;
const AUTO_RETRY_DELAYS_MS = [1000, 3000];
type AppSource = { url: string; type: string };

const params = new URLSearchParams(window.location.search);
const appId = params.get('app');

if (!appId) {
  document.getElementById('loading')!.textContent = 'Missing app parameter';
} else {
  loadApp(appId);
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
  // Fast path: if the background already knows the dev server is offline,
  // skip the 12s iframe load wait and surface the offline message immediately.
  // Userscripts come from cache; the UI page does not (multi-asset bundle).
  const onlineCheck = await chrome.storage.local.get(DEV_SERVER_ONLINE_KEY);
  if (onlineCheck[DEV_SERVER_ONLINE_KEY] === false) {
    renderOfflineMessage(appId);
    return;
  }

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await chrome.storage.local.get(APP_SOURCES_KEY);
    const sourceMap = (result[APP_SOURCES_KEY] || {}) as Record<string, { url: string; type: string }>;
    const source = sourceMap[appId];

    if (source?.url) {
      mountApp(appId, source);
      return;
    }

    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.error(`[airglow] No source registered for app '${appId}' after ${maxAttempts} attempts`);
  document.getElementById('loading')!.textContent = `App '${appId}' not found. Is the dev server running?`;
}

function mountApp(appId: string, source: AppSource) {
  const baseUrl = source.url.replace(/\/+$/, '');
  let iframe: HTMLIFrameElement | null = null;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  let loadAttempt = 0;
  let runtimeCrashVisible = false;
  let appName: string | undefined;

  // Set tab title from cached manifests populated by the background loader.
  chrome.storage.local.get(APP_MANIFESTS_KEY).then((result) => {
    const manifests = Array.isArray(result[APP_MANIFESTS_KEY]) ? result[APP_MANIFESTS_KEY] : [];
    const manifest = manifests.find((m: any) => m?.id === appId);
    if (manifest?.name) {
      appName = manifest.name;
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

  let emailPromptPromise: Promise<string> | null = null;

  async function ensureUserEmail(): Promise<string> {
    const result = await chrome.storage.local.get(USER_EMAIL_KEY);
    const storedEmail = normalizeUserEmail(result[USER_EMAIL_KEY]);
    if (storedEmail) return storedEmail;
    if (emailPromptPromise) return emailPromptPromise;

    emailPromptPromise = new Promise((resolve) => {
      const existing = document.getElementById('airglow-email-required');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'airglow-email-required';
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:24px',
        'background:rgba(245,245,244,.96)',
        'color:#1c1917',
        'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      ].join(';');
      overlay.innerHTML = `
        <form id="airglow-email-required-form" style="width:min(460px,100%);border:1px solid #e7e5e4;border-radius:10px;background:#fff;padding:22px;box-shadow:0 12px 32px rgba(28,25,23,.14)">
          <div style="font-size:13px;color:#78716c;margin-bottom:6px">Airglow setup</div>
          <div style="font-size:20px;font-weight:650;line-height:1.25;margin-bottom:8px">Email required</div>
          <div style="font-size:14px;line-height:1.5;color:#57534e;margin-bottom:16px">Airglow stores your email locally in this extension so apps can identify this browser. Apps stay paused until this is filled.</div>
          <input id="airglow-email-required-input" type="email" required placeholder="you@example.com" style="box-sizing:border-box;width:100%;height:40px;padding:0 12px;border:1px solid #d6d3d1;border-radius:6px;background:#fafaf9;color:#1c1917;font-size:14px;outline:none" />
          <div id="airglow-email-required-error" style="display:none;margin-top:8px;color:#b91c1c;font-size:13px">Enter a valid email address.</div>
          <button type="submit" style="margin-top:16px;height:38px;padding:0 16px;border:0;border-radius:999px;background:#1c1917;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Continue</button>
        </form>
      `;

      document.body.appendChild(overlay);
      const form = document.getElementById('airglow-email-required-form') as HTMLFormElement | null;
      const input = document.getElementById('airglow-email-required-input') as HTMLInputElement | null;
      const error = document.getElementById('airglow-email-required-error') as HTMLDivElement | null;
      input?.focus();

      form?.addEventListener('submit', (event) => {
        event.preventDefault();
        const email = normalizeUserEmail(input?.value);
        if (!email) {
          if (error) error.style.display = 'block';
          if (input) input.style.borderColor = '#b91c1c';
          return;
        }
        chrome.runtime.sendMessage({ type: 'airglow:identity:setUserEmail', _airglow: true, _appId: appId, email }, () => {
          overlay.remove();
          emailPromptPromise = null;
          resolve(email);
        });
      });
    });

    return emailPromptPromise;
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
    iframe.src = buildUiUrl(cacheBust);
    scheduleLoadTimeout();
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

    void (async () => {
      if (requiresUserEmail(data.type)) {
        await ensureUserEmail();
      }

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
    })().catch((error) => {
      sourceWindow?.postMessage(
        {
          _airglow_response: true,
          _callId: data._callId,
          error: error?.message || String(error),
          code: error?.code || 'EMAIL_REQUIRED',
        },
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
  };
  iframe.onerror = () => {
    showCrashOverlay(
      `App '${appId}' failed to load`,
      'The browser reported an iframe load error. Reloading this app iframe should recover after a transient server or network issue.',
    );
  };

  document.body.appendChild(iframe);
  mountFeedbackButton();
  reloadIframe(false);

  function mountFeedbackButton() {
    if (!runtimeConfig.enableFeedback) return;
    const button = document.createElement('button');
    button.id = 'airglow-feedback-button';
    button.type = 'button';
    button.textContent = 'Feedback';
    button.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483646',
      'height:34px',
      'padding:0 13px',
      'border:1px solid rgba(214,211,209,.9)',
      'border-radius:999px',
      'background:rgba(255,255,255,.92)',
      'color:#1c1917',
      'font:600 13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 8px 24px rgba(28,25,23,.16)',
      'cursor:pointer',
    ].join(';');
    button.addEventListener('click', () => openFeedbackForm());
    document.body.appendChild(button);
  }

  function openFeedbackForm() {
    const existing = document.getElementById('airglow-feedback-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'airglow-feedback-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:flex-end',
      'justify-content:flex-end',
      'padding:20px',
      'background:rgba(28,25,23,.18)',
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    ].join(';');
    overlay.innerHTML = `
      <form id="airglow-feedback-form" style="width:min(420px,100%);border:1px solid #e7e5e4;border-radius:12px;background:#fff;padding:16px;box-shadow:0 16px 40px rgba(28,25,23,.18);color:#1c1917">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px">
          <div>
            <div style="font-size:13px;color:#78716c">Airglow feedback</div>
            <div style="font-size:18px;font-weight:650">What should we fix or improve?</div>
          </div>
          <button id="airglow-feedback-close" type="button" style="border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:#78716c">×</button>
        </div>
        <select id="airglow-feedback-kind" style="box-sizing:border-box;width:100%;height:36px;border:1px solid #d6d3d1;border-radius:6px;background:#fafaf9;color:#1c1917;margin-bottom:8px;padding:0 10px">
          <option value="general">General</option>
          <option value="bug">Bug</option>
          <option value="idea">Idea</option>
        </select>
        <textarea id="airglow-feedback-message" required minlength="3" maxlength="2000" placeholder="Short note. Please don't paste secrets, prompts, or page content." style="box-sizing:border-box;width:100%;min-height:120px;border:1px solid #d6d3d1;border-radius:6px;background:#fafaf9;color:#1c1917;padding:10px;font-size:14px;resize:vertical"></textarea>
        <div id="airglow-feedback-status" style="min-height:18px;margin-top:8px;font-size:13px;color:#57534e"></div>
        <button id="airglow-feedback-submit" type="submit" style="margin-top:8px;height:36px;padding:0 14px;border:0;border-radius:999px;background:#1c1917;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Send feedback</button>
      </form>
    `;
    document.body.appendChild(overlay);
    document.getElementById('airglow-feedback-close')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) overlay.remove();
    });
    const form = document.getElementById('airglow-feedback-form') as HTMLFormElement | null;
    const message = document.getElementById('airglow-feedback-message') as HTMLTextAreaElement | null;
    const kind = document.getElementById('airglow-feedback-kind') as HTMLSelectElement | null;
    const status = document.getElementById('airglow-feedback-status') as HTMLDivElement | null;
    message?.focus();
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitFeedback(kind?.value || 'general', message?.value || '', status, overlay);
    });
  }

  async function submitFeedback(kind: string, message: string, status: HTMLDivElement | null, overlay: HTMLDivElement) {
    try {
      const email = await ensureUserEmail();
      const userHash = await sha256Email(email);
      const endpoint = runtimeConfig.feedbackEndpoint;
      if (!runtimeConfig.enableFeedback || !endpoint || !userHash) throw new Error('Feedback is not configured.');
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userHash,
          kind,
          message,
          appId,
          appName,
          sourceType: source.type,
        }),
      });
      if (!res.ok) throw new Error(`Feedback HTTP ${res.status}`);
      if (status) status.textContent = 'Sent. Thank you.';
      setTimeout(() => overlay.remove(), 600);
    } catch (error) {
      logger.warn('airglow', `feedback submit failed: ${error instanceof Error ? error.message : String(error)}`);
      if (status) {
        status.style.color = '#b91c1c';
        status.textContent = error instanceof Error ? error.message : 'Could not send feedback.';
      }
    }
  }
}

createPersistentButton();

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
