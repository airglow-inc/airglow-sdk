import { defineConfig } from 'wxt';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  dev: {
    server: { port: 3100 },
  },
  webExt: {
    disabled: true,
  },
  vite: () => ({
    plugins: [
      react() as any,
      tailwindcss() as any,
    ],
  }),
  manifest: {
    name: 'Airglow',
    description: 'Dynamic tool injection platform — AI-powered integrations on any page',
    permissions: ['storage', 'userScripts', 'declarativeNetRequest', 'scripting', 'webNavigation', 'nativeMessaging', 'identity', 'offscreen', 'alarms'],
    host_permissions: ['<all_urls>'],
    // Pinned public key → deterministic extension ID: comikpjjijckpjkobpkkpnnhlcpmagic
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA9FHeG+dnrLhRUck2ePMNCSv6cdemPh2AvKYRnGeMLCXA4cWa80uxRGp3inkhl8kTH5Q3ctLJ2GGqf9YwLEoqDPYdbQ+q7U2l6oEInTzz5ZdDnxOh47SiuyrsQSmEODRPSiScIdv9f3BD5YPtLeDxbx6qjGoQ3oqemPTthDir+b/b4V2jGhcrZrh2NYpk2jGrHqkVdq2L5sYLy0SEQoApsOOOaU22s3i8eVA0KBEQL46r07ItpfJm2373TZrWOhE/DIBGhWGSoQIJtGchW9KU8TALuTsWNV14waeDrE8PH0pnbmqoQJJGRyrZaUl1KB0K85+X7x+ue5Ns3lrC/dEnugIDAQAB',
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
      256: 'icon-256.png',
    },
    sandbox: {
      pages: ['startup-sandbox.html', 'app-ui-sandbox.html'],
    },
    content_security_policy: {
      sandbox: [
        'sandbox allow-scripts allow-forms allow-popups allow-modals',
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "connect-src 'self' http://127.0.0.1:* http://localhost:* https:",
        "img-src 'self' data: blob: http: https:",
        "style-src 'self' 'unsafe-inline' http: https:",
        "font-src 'self' data: http: https:",
      ].join('; '),
    },
    content_scripts: [{
      matches: ['<all_urls>'],
      exclude_matches: ['*://localhost/*'],
      js: ['content-scripts/edge-button.js'],
      run_at: 'document_idle',
    }],
    // Expose bundled fonts so injected UI (e.g. the "Airglow is using this tab"
    // banner) can @font-face them and render consistently across sites/OSes.
    web_accessible_resources: [{
      resources: ['fonts/*'],
      matches: ['<all_urls>'],
    }],
    action: {},
    commands: {
      '_execute_action': {
        suggested_key: { default: 'Alt+G' },
      },
    },
  },
});
