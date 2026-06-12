import { createEdgeButton, removeEdgeButtonSurfaces } from '../lib/edge-button';

const AIRGLOW_SESSION_TOKEN_KEY = '__airglow_session_token';
const AIRGLOW_AUTH_PROVIDER_KEY = '__airglow_auth_provider';

async function browserIsSignedInToAirglow(): Promise<boolean> {
  const stored = await chrome.storage.local.get([AIRGLOW_SESSION_TOKEN_KEY, AIRGLOW_AUTH_PROVIDER_KEY]);
  const token = typeof stored[AIRGLOW_SESSION_TOKEN_KEY] === 'string' ? stored[AIRGLOW_SESSION_TOKEN_KEY] : '';
  const provider = typeof stored[AIRGLOW_AUTH_PROVIDER_KEY] === 'string' ? stored[AIRGLOW_AUTH_PROVIDER_KEY] : '';
  return Boolean(token && (provider === 'email' || provider === 'google'));
}

export default defineContentScript({
  matches: ['<all_urls>'],
  excludeMatches: ['*://localhost/*'],
  runAt: 'document_idle',
  main() {
    browserIsSignedInToAirglow()
      .then((signedIn) => {
        if (signedIn) createEdgeButton();
        else removeEdgeButtonSurfaces();
      })
      .catch(() => removeEdgeButtonSurfaces());

    chrome.storage.local.onChanged.addListener((changes) => {
      if (!(AIRGLOW_SESSION_TOKEN_KEY in changes) && !(AIRGLOW_AUTH_PROVIDER_KEY in changes)) return;
      browserIsSignedInToAirglow()
        .then((signedIn) => {
          if (signedIn) createEdgeButton();
          else removeEdgeButtonSurfaces();
        })
        .catch(() => removeEdgeButtonSurfaces());
    });
  },
});
