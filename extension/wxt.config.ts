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
    // 'tabs' exposes url/title for chrome:// and other-extension pages in
    // tabs.query (no new install warning — <all_urls> already covers it).
    // 'debugger' is used only to drive our OWN chrome-extension:// pages
    // (the dashboard and side panel) — host_permissions can't match that scheme, so
    // chrome.scripting/userScripts are flatly refused there. Normal http(s)
    // pages keep the scripting path (no debugger infobar).
    permissions: ['storage', 'tabs', 'userScripts', 'declarativeNetRequest', 'scripting', 'webNavigation', 'nativeMessaging', 'identity', 'identity.email', 'offscreen', 'sidePanel', 'debugger', 'alarms'],
    host_permissions: ['<all_urls>'],
    // Pinned public key → deterministic extension ID: comikpjjijckpjkobpkkpnnhlcpmagic
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA9FHeG+dnrLhRUck2ePMNCSv6cdemPh2AvKYRnGeMLCXA4cWa80uxRGp3inkhl8kTH5Q3ctLJ2GGqf9YwLEoqDPYdbQ+q7U2l6oEInTzz5ZdDnxOh47SiuyrsQSmEODRPSiScIdv9f3BD5YPtLeDxbx6qjGoQ3oqemPTthDir+b/b4V2jGhcrZrh2NYpk2jGrHqkVdq2L5sYLy0SEQoApsOOOaU22s3i8eVA0KBEQL46r07ItpfJm2373TZrWOhE/DIBGhWGSoQIJtGchW9KU8TALuTsWNV14waeDrE8PH0pnbmqoQJJGRyrZaUl1KB0K85+X7x+ue5Ns3lrC/dEnugIDAQAB',
    // Google sign-in: chrome.identity.getAuthToken requires this OAuth client
    // (type "Chrome Extension", bound to the Web Store id
    // angbnggmaccjdinfebjoibdklmckinfb) declared in the manifest. On local
    // builds the extension id differs, so getAuthToken errors and
    // lib/airglow-auth.ts falls back to launchWebAuthFlow. Client ids are
    // public values; the env var exists for forks pointing at their own
    // Google project (keep in sync with the default in lib/airglow-auth.ts).
    oauth2: {
      client_id: process.env.WXT_GOOGLE_EXT_CLIENT_ID
        || '290831017812-6833j8lm6kuc3u75v6jvcnba7hmobsls.apps.googleusercontent.com',
      scopes: ['openid', 'email', 'profile'],
    },
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
      256: 'icon-256.png',
    },
    sandbox: {
      pages: ['startup-sandbox.html'],
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
    // edge-button content script is auto-registered from
    // entrypoints/edge-button.content.ts (matches/excludeMatches/runAt declared
    // there) — no manual content_scripts entry needed.
    // Expose bundled fonts so injected UI (e.g. the "Airglow is using this tab"
    // banner) can @font-face them and render consistently across sites/OSes.
    web_accessible_resources: [{
      resources: ['fonts/*'],
      matches: ['<all_urls>'],
    }],
    action: {},
    commands: {
      'reload-extension': {
        suggested_key: { default: 'Alt+G' },
        description: 'Reload the extension (pick up a fresh build)',
      },
      '_execute_action': {
        suggested_key: { default: 'Alt+Shift+G' },
      },
    },
  },
});
