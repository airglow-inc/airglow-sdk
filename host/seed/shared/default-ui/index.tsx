import { createRoot } from 'react-dom/client';
import { AppPage } from '@shared/components';

// The default app page. The daemon serves this for any app that ships no `ui/`
// of its own, so every app has a settings + overview surface with the standard
// header (title, description, status, Enable/Disable, Uninstall). AppPage
// derives the app's name/description/status from the manifest, so only the
// appId is needed — the daemon injects `__airglow_app_id`; the `?app=` query
// param is a fallback for standalone opens.
const appId =
  (window as any).__airglow_app_id ||
  new URLSearchParams(location.search).get('app') ||
  '';

const root = document.getElementById('root');
if (root) createRoot(root).render(<AppPage appId={appId} />);
