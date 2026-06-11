// Talks to the extension's app-shell page (the parent of an app UI iframe)
// for dashboard-level actions the airglow.* SDK doesn't cover: listing all
// apps (cloud + local) and opening other apps / the dashboard.
//
// The app-shell relays any `{_airglow: true}` postMessage to
// chrome.runtime.sendMessage and posts the response back as
// `{_airglow_response: true, _callId}`. The injected SDK uses numeric
// _callIds; we prefix ours with 'apppage:' so the two response listeners
// never collide on the same id.

export type SourcedManifest = {
  id: string;
  name: string;
  description?: string;
  _sourceType: 'local' | 'cloud';
  visibility?: 'public' | 'hidden';
};

let callCounter = 0;
const pending = new Map<string, (response: any) => void>();
let listening = false;

export function isEmbedded(): boolean {
  return window.parent !== window;
}

function ensureListener() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d?._airglow_response || typeof d._callId !== 'string') return;
    const cb = pending.get(d._callId);
    if (cb) {
      pending.delete(d._callId);
      cb(d);
    }
  });
}

export function shellCall(
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 1500,
): Promise<any> {
  if (!isEmbedded()) return Promise.reject(new Error('not embedded in app-shell'));
  ensureListener();
  return new Promise((resolve, reject) => {
    const callId = `apppage:${++callCounter}`;
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error(`app-shell call timed out: ${type}`));
    }, timeoutMs);
    pending.set(callId, (response) => {
      clearTimeout(timer);
      if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
    window.parent.postMessage({ type, ...payload, _airglow: true, _callId: callId }, '*');
  });
}

export async function getDashboardManifests(): Promise<SourcedManifest[]> {
  const res = await shellCall('airglow:get-dashboard-manifests');
  return Array.isArray(res?.manifests) ? res.manifests : [];
}

export function openApp(appId: string): Promise<void> {
  return shellCall('airglow:open-app', { appId }).then(() => undefined);
}

// background's open-dashboard branch never calls sendResponse — fire and
// forget (the tab still opens; the relay's error response is irrelevant).
export function openDashboard(): void {
  if (!isEmbedded()) return;
  window.parent.postMessage(
    { type: 'airglow:open-dashboard', _airglow: true, _callId: `apppage:${++callCounter}` },
    '*',
  );
}
