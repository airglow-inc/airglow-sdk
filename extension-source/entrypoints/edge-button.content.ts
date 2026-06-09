import { createEdgeButton } from '../lib/edge-button';

const SIDE_BUTTON_KEY = '__side_button_enabled';

export default defineContentScript({
  matches: ['<all_urls>'],
  excludeMatches: ['*://localhost/*'],
  runAt: 'document_idle',
  async main() {
    let handle: { destroy: () => void } | null = null;

    function apply(enabled: boolean) {
      if (enabled && !handle) handle = createEdgeButton();
      else if (!enabled && handle) {
        handle.destroy();
        handle = null;
      }
    }

    const stored = await chrome.storage.local.get(SIDE_BUTTON_KEY);
    apply(!!stored[SIDE_BUTTON_KEY]);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(SIDE_BUTTON_KEY in changes)) return;
      apply(!!changes[SIDE_BUTTON_KEY].newValue);
    });
  },
});
