# Airglow app developer guide

An Airglow app is a directory in this workspace containing a `manifest.json` plus any of four optional parts:

- **Userscripts** — JS/TS injected into matching web pages
- **UI** — a React + Tailwind dashboard that opens from the extension toolbar
- **Startup** — code that runs once per browser launch
- **Server functions** — Node functions called from userscripts and UI via RPC

All four use the `airglow.*` SDK ([`sdk-reference.md`](sdk-reference.md)); there's no `chrome.*` access. Server functions also get Node and unprefixed `.env` secrets.

---

## Running the dev server

Run `pnpm airglow dev` from the workspace root. Serves manifests, bundles userscripts
and UI, runs RPC calls, and installs the native-host debug bridge — all on
`http://127.0.0.1:3222`. The extension reloads matching tabs when userscripts change.
See [`../../cli/README.md`](../../cli/README.md) for flags and endpoints.

---

## manifest.json

```json
{
  "id": "hn-tagger",
  "name": "HN Tagger",
  "version": "0.1.0",
  "description": "AI-generated tags for every HN title",
  "tags": ["hacker news", "tagging"],
  "visibility": "public",

  "startup": "startup.ts",

  "userscripts": [
    { "file": "userscripts/hn.ts", "matches": ["*://news.ycombinator.com/*"] }
  ],

  "host_permissions": ["*://*.google.com/*"],

  "secrets": {
    "ANTHROPIC_API_KEY": { "label": "Anthropic API Key" }
  },

  "server_env": {
    "COMPOSIO_API_KEY": { "label": "Composio API Key" }
  }
}
```

| Field | Purpose |
|---|---|
| `id` | Unique app id. Must equal the directory name. Used for storage namespacing and URL routing. |
| `name`, `version`, `description` | Shown in the extension dashboard. |
| `tags` | Optional. Displayed in dashboard. |
| `visibility` | `"public"` (default), `"development"`, or `"hidden"`. `hidden` apps are skipped entirely. |
| `defaultEnabled` | First-encounter default in the extension. When `false`, the extension starts the app disabled the first time it sees this `id`; after that the user's dashboard toggle is authoritative. Defaults to `true`. |
| `startup` | Path to a startup script. Runs once per extension boot. |
| `userscripts[]` | Each entry: `{ file, matches, allFrames?, runAt? }`. `matches` uses [Chrome match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns). `runAt` defaults to `"document_idle"`. |
| `host_permissions` | Chrome match patterns. Required for `airglow.fetch(..., { includeCookies: true })` on the listed origins. |
| `secrets` | Client-scoped secrets the app needs. Keys appear in the extension's Secrets UI labelled by `label`. Values read via `airglow.storage.get('KEY')`. |
| `server_env` | Server-scoped env vars the app needs. Keys checked against workspace + per-app `.env` at `pnpm airglow dev` startup; missing keys are warned in the console. Values read via `process.env.KEY` from `server/*.ts`. Declarative only — not enforced. |

---

## Userscripts

Files declared under `manifest.userscripts[]`. The extension registers each one with `chrome.userScripts.register()` in the `USER_SCRIPT` world — full DOM access, isolated `window`, no `chrome.*`.

```ts
// userscripts/hn.ts
const titles = document.querySelectorAll('.titleline > a');
// manipulate the page, call airglow.fetch / airglow.storage / airglow.rpc
```

The user must have "Allow User Scripts" enabled on the extension detail page (Chrome 138+).

---

## UI

A React + Tailwind SPA that runs inside a sandboxed iframe at `app-shell.html?app=<id>`, opened from the extension toolbar.

```
package.json     # react, react-dom, tailwindcss, @tailwindcss/cli
ui/
  App.tsx        # entry, self-mounts
  globals.css    # imports the shared theme (optional)
```

```tsx
// ui/App.tsx
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [logs, setLogs] = useState([]);
  useEffect(() => { airglow.storage.get('logs').then(setLogs); }, []);
  return (
    <div className="p-4 bg-stone-100 min-h-screen">
      <h1 className="text-xl font-semibold mb-4">Run history</h1>
      {logs.map(l => <div key={l.ts} className="text-sm text-stone-600">{l.ts} — {l.message}</div>)}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
```

```css
/* ui/globals.css */
@import "tailwindcss";
@import "../../shared/theme/tailwind-theme.css";
```

If `ui/globals.css` exists the dev server bundles Tailwind for the app; otherwise basic reset styles apply.

---

## Startup

`startup.ts` runs once per extension boot — on browser launch, on extension reload, and on extension update. It must be **idempotent**.

Access to `airglow.storage`, `airglow.log`, and `airglow.platform`; no DOM and no `airglow.fetch`. Use it for platform setup — domain redirects, iframe permissions.

```ts
// startup.ts
const sites = (await airglow.storage.get('blocked_sites')) ?? ['instagram.com', 'x.com'];
await airglow.platform.registerRedirects([
  { domains: sites, target: 'airglow://focus-blocker' }
]);
```

---

## Server functions

The default export of `server/<name>.ts` becomes an RPC endpoint, callable from userscripts or UI via `airglow.rpc('<name>', payload)`. Use server functions for anything that needs Node or real secrets.

```ts
// server/tag.ts
export default async function(body: { titles: string[] }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // ...call the API
  return { tags: [...] };
}
```

- `body` — payload passed to `airglow.rpc()`.
- `process.env` — server-only secrets from `.env` (unprefixed; see [Secrets](#secrets)).
- Return value is JSON-serialized.
- Any Node package works (`fs`, `crypto`, `child_process`, …).
- Throw or return non-2xx to make `airglow.rpc()` reject.

---

## Secrets

Two scopes, distinguished by the `CLIENT_` prefix in `.env`.

```bash
# airglow-apps/.env — workspace-wide
CLIENT_ANTHROPIC_API_KEY=sk-ant-...       # browser
COMPOSIO_API_KEY=ak_...                    # server
GOOGLE_CLIENT_SECRET=GOCSPX-...            # server

# airglow-apps/<app>/.env — app-specific, overrides workspace
CLIENT_NOTION_PAGE_ID=abc123
```

- **`CLIENT_*`** — preloaded into `chrome.storage.local` as defaults. Apps read via `airglow.storage.get('FOO')` (without the prefix). User-set values in the Secrets UI override `.env`. Declare in `manifest.secrets` so the key appears in the extension's Secrets UI.
- **Unprefixed** — server-only. Available as `process.env.FOO` from `server/*.ts`. Never sent to the browser. Declare in `manifest.server_env` so `pnpm airglow dev` warns at startup when a required key is missing.

App `.env` overrides workspace `.env`.

---

## Composio integrations

Composio (`@composio/core` v3, ^0.10) calls third-party APIs (Gmail, Notion, Sheets, Calendar, …) from server functions. Its API key is server-only — only call `@composio/core` from `server/*.ts`.

**v3 terminology**: `tools` (the callable verbs, e.g. `GMAIL_FETCH_MESSAGE`), `toolkits` (groupings, e.g. `gmail`), `auth_configs` (OAuth client config per toolkit), `connected_accounts` (per-user OAuth tokens). `entity ID` → `user_id`, `integration` → `auth_config`.

Discover tools and their parameter schemas:

```bash
pnpm composio <toolkit>                # list tools (gmail, notion, googlesheets, …)
pnpm composio <toolkit> <TOOL_SLUG>    # parameter schema for one tool
```

### Calling a tool (no OAuth)

Public/no-auth tools (e.g. Hacker News, web search):

```ts
import { Composio } from '@composio/core';

const c = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const result = await c.tools.execute('HACKERNEWS_GET_USER', {
  userId: 'default',
  arguments: { user_id: 'pg' },
  dangerouslySkipVersionCheck: true,
});
```

- `userId` — Composio's per-user auth context. Constant string is fine for tools that don't need OAuth.
- `arguments` — tool parameter object; shape from `pnpm composio <toolkit> <TOOL_SLUG>`.
- `dangerouslySkipVersionCheck: true` — required; bypasses tool-version pinning.

### Calling a tool that requires user OAuth (Gmail, Calendar, Sheets, …)

Two-step flow: (1) ensure a `connected_account` exists for `(user_id, toolkit)`, (2) execute the tool. Pre-step 1: an `auth_config` for the toolkit. Auto-create it once with Composio-managed OAuth.

```ts
import { Composio } from '@composio/core';

const c = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const authConfigCache = new Map<string, string>();

async function getOrCreateAuthConfigId(toolkitSlug: string): Promise<string> {
  if (authConfigCache.has(toolkitSlug)) return authConfigCache.get(toolkitSlug)!;
  const list = await c.authConfigs.list({ toolkit: toolkitSlug });
  const existing = (list.items ?? []).find((cfg: any) =>
    cfg?.toolkit?.slug === toolkitSlug || cfg?.toolkit === toolkitSlug,
  );
  const id = existing?.id ?? (await c.authConfigs.create(toolkitSlug.toUpperCase(), {
    type: 'use_composio_managed_auth',
    name: `Auto: ${toolkitSlug}`,
  })).id;
  authConfigCache.set(toolkitSlug, id);
  return id;
}

export default async function fetchSheet(body: { userEmail: string; spreadsheetId: string }) {
  const userId = `myapp-${body.userEmail.toLowerCase()}`;

  // 1. Check connection. If missing, return a redirect URL for the user.
  const accounts = await c.connectedAccounts.list({ userIds: [userId], toolkitSlugs: ['googlesheets'] });
  const connected = (accounts.items ?? []).some((a: any) => a.status === 'ACTIVE');
  if (!connected) {
    const authConfigId = await getOrCreateAuthConfigId('googlesheets');
    const req = await c.connectedAccounts.link(userId, authConfigId);
    return { ok: false, needsAuth: true, authUrl: req.redirectUrl };
  }

  // 2. Execute the tool.
  const result = await c.tools.execute('GOOGLESHEETS_BATCH_GET', {
    userId,
    arguments: { spreadsheet_id: body.spreadsheetId, ranges: ["'Sheet1'!A1:H100"] },
    dangerouslySkipVersionCheck: true,
  });
  const data = (result as any)?.data || result;
  return { ok: true, valueRanges: data?.valueRanges ?? [] };
}
```

- The userscript handles `{ needsAuth: true, authUrl }` by opening `authUrl` with `airglow.openWindow` so the user completes OAuth.
- `auth_configs` persist server-side under your `COMPOSIO_API_KEY`. After first run for a toolkit, subsequent `authConfigs.list()` returns the existing one — no duplicate creation.
- `use_composio_managed_auth` uses Composio's own OAuth app (small Composio branding on the consent screen). For your own branding, create a `use_custom_auth` config with your OAuth client credentials.
- Result shape varies per toolkit. Unwrap as `result.data` (sometimes nested under `response_data`).
- `userId` namespacing: pick one canonical scheme per app (e.g. `myapp-<email>`) so auth state survives reconnects. Avoid raw emails — Composio treats `user_id` as opaque.

See `gmail-calendar/server/_composio.ts` for the helper used by gmail-calendar's two server functions.

---

## Gotchas

- **No `localStorage` / `IndexedDB`** — all UIs share an origin. Use `airglow.storage`.
- **No cross-app imports** — put shared code in `shared/`.
- **No `window.open()` in userscripts** — isolated `window`. Use `airglow.openWindow()`.
- **`startup.ts` must be idempotent** — it runs on every boot.
- **`server/` is Node, not browser** — don't import `window`, `document`, `chrome.*`, or `react-dom`.
- **`airglow.fetch` return shape is limited** — `{ status, ok, json(), text() }`. For headers or streaming, use a server function with native `fetch`.
- **Anthropic SDK in the browser** needs `dangerouslyAllowBrowser: true`, or use `airglow.fetch` directly.
