import { createEdgeButton, EDGE_BUTTON_POS_KEY } from '../lib/edge-button';

const SIDE_BUTTON_KEY = '__side_button_enabled';
const DISABLED_APPS_KEY = '__disabled_apps';

export default defineContentScript({
  matches: ['<all_urls>'],
  excludeMatches: ['*://localhost/*'],
  runAt: 'document_idle',
  async main() {
    let handle: { destroy: () => void } | null = null;
    let enabled = false;
    let posFrac: number | undefined;

    function pageHasActiveApps(): Promise<boolean> {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'airglow:get-page-apps', url: location.href }, (res) => {
          resolve(Array.isArray(res?.apps) && res.apps.some((a: { disabled: boolean }) => !a.disabled));
        });
      });
    }

    // The button appears only when the preference is on AND at least one
    // enabled app matches this page. Once shown it stays until navigation —
    // yanking it (and its popup) out from under the cursor right after the
    // user disables the last app via the popup toggle would be worse.
    async function sync() {
      if (!enabled) {
        handle?.destroy();
        handle = null;
        return;
      }
      if (handle) return;
      const hasApps = await pageHasActiveApps();
      if (hasApps && enabled && !handle) handle = createEdgeButton({ initialPos: posFrac });
    }

    const stored = await chrome.storage.local.get([SIDE_BUTTON_KEY, EDGE_BUTTON_POS_KEY]);
    enabled = !!stored[SIDE_BUTTON_KEY];
    posFrac = typeof stored[EDGE_BUTTON_POS_KEY] === 'number' ? stored[EDGE_BUTTON_POS_KEY] : undefined;
    void sync();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (EDGE_BUTTON_POS_KEY in changes && typeof changes[EDGE_BUTTON_POS_KEY].newValue === 'number') {
        posFrac = changes[EDGE_BUTTON_POS_KEY].newValue;
      }
      if (SIDE_BUTTON_KEY in changes) enabled = !!changes[SIDE_BUTTON_KEY].newValue;
      if (SIDE_BUTTON_KEY in changes || DISABLED_APPS_KEY in changes) void sync();
    });
  },
});
