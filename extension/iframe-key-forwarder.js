// Iframe keyboard forwarder — injected by chrome.scripting.registerContentScripts
// into about:blank/srcdoc iframes where chrome.userScripts can't reach.
// Forwards modifier+key events to the top frame via postMessage.
(function() {
  if (window === window.top) return;

  // Forward modifier+key events to the top frame
  document.addEventListener('keydown', function(e) {
    if (e.key.length === 1 && (e.metaKey || e.ctrlKey || e.altKey)) {
      var sel = '';
      try { sel = window.getSelection().toString().trim(); } catch(ignored) {}
      try {
        window.top.postMessage({
          __airglowKeyForward: true,
          key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey,
          altKey: e.altKey, shiftKey: e.shiftKey, selection: sel
        }, '*');
      } catch(err) {}
    }
  }, true);

  // Top frame can request a copy (for canvas-based editors like Google Docs)
  window.addEventListener('message', function(e) {
    if (e.data && e.data.__airglowCopyRequest) {
      document.execCommand('copy');
    }
  });
})();
