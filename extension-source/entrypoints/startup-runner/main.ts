// Offscreen document bridging background ↔ sandbox iframe for startup eval.
// SDK calls from sandbox go to background via chrome.runtime.sendMessage.

const sandbox = document.getElementById('sandbox') as HTMLIFrameElement;

let sandboxReady = false;
const pendingRuns: any[] = [];

window.addEventListener('message', (e) => {
  const data = e.data;
  if (!data?.type && !data?._airglow) return;

  if (data.type === 'airglow:startup:ready') {
    sandboxReady = true;
    for (const msg of pendingRuns) {
      sandbox.contentWindow?.postMessage(msg, '*');
    }
    pendingRuns.length = 0;
    return;
  }

  // Standard SDK call from sandbox → forward to background via sendMessage
  if (data._airglow) {
    chrome.runtime.sendMessage(data, (response: any) => {
      sandbox.contentWindow?.postMessage(
        { _airglow_response: true, _callId: data._callId, ...response },
        '*',
      );
    });
    return;
  }

  // Startup done → forward to background
  if (data.type === 'airglow:startup:done') {
    chrome.runtime.sendMessage(data);
    return;
  }
});

// Listen for startup:run from background
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg?.type === 'airglow:startup:run') {
    if (sandboxReady) {
      sandbox.contentWindow?.postMessage(msg, '*');
    } else {
      pendingRuns.push(msg);
    }
    return false; // Don't keep channel open — not using sendResponse
  }
  // For SDK calls: don't interfere — let background handle them
  return false;
});

console.log('[Offscreen] Document loaded and ready');
