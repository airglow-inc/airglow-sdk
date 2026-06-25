// Wires an app UI loaded as a standalone TOP-LEVEL tab (e.g. opened by
// `airglow browser open --app <id>` for agent testing).
//
// App UIs run the app_ui SDK, which always talks via window.parent.postMessage
// (they load at the daemon's web origin, where chrome.runtime.sendMessage needs
// an extension id and would throw). Inside the dashboard, the shell's AppFrame
// answers those messages. Standalone there is no parent — window.parent === window
// — so the SDK posts to itself and every airglow.* call hangs (the page sits at
// its loading state forever). This content script is the missing answerer: it
// relays {_airglow} requests to the background and posts the {_airglow_response}
// back, making the standalone page fully wired — and, being a normal top-level
// http page, natively scriptable with eval/html/shot (no --frame, no OOPIF).
//
// Mirrors extension/entrypoints/dashboard/App.tsx → AppFrame's message handler.

export default defineContentScript({
  // Daemon web origin only (app UIs are served from 127.0.0.1:<port>/api/apps/<id>/ui).
  // Chrome match patterns ignore the port, so any daemon port is covered.
  matches: ['http://127.0.0.1/*', 'http://localhost/*'],
  // Top frame only: an app UI embedded in the dashboard iframe is already bridged
  // by the shell, so we must not double-answer it.
  allFrames: false,
  runAt: 'document_start',
  main() {
    // Only the app-UI route; leave other daemon pages (api, etc.) untouched.
    if (!/\/api\/apps\/[^/]+\/ui(\b|\/|$)/.test(location.pathname)) return;
    // Pin the appId from the URL. The background also validates that the claimed
    // _appId matches the sender page's ?app= param, so this can't scope to another app.
    const appId = new URLSearchParams(location.search).get('app');
    if (!appId) return;

    window.addEventListener('message', (e) => {
      // The SDK posts to window.parent, which for a top-level tab is this window.
      if (e.source !== window) return;
      const data = e.data as any;
      if (!data || data._airglow !== true || data._callId == null) return;
      chrome.runtime.sendMessage({ ...data, _appId: appId }, (response: any) => {
        const payload = chrome.runtime.lastError
          ? { error: chrome.runtime.lastError.message || 'Chrome runtime message failed', code: 'CHROME_RUNTIME_ERROR' }
          : response || {};
        window.postMessage({ _airglow_response: true, _callId: data._callId, ...payload }, '*');
      });
    });
  },
});
