import { createEdgeButton } from '../lib/edge-button';

export default defineContentScript({
  matches: ['<all_urls>'],
  excludeMatches: ['*://localhost/*'],
  runAt: 'document_idle',
  main() {
    createEdgeButton();
  },
});
