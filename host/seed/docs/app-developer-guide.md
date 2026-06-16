# Airglow app developer guide

An Airglow app is a directory under `apps/` in this workspace containing a `manifest.json` plus any of four optional parts:

- **Userscripts** — JS/TS injected into matching web pages
- **UI** — a React + Tailwind app page, embedded in the extension dashboard
- **Startup** — code that runs once per browser launch
- **Server functions** — functions running on this machine, called from userscripts and UI via RPC

All four use the `airglow.*` SDK ([`sdk-reference.md`](sdk-reference.md)); there's no `chrome.*` access. Server functions also get Node APIs (running under Bun) and unprefixed `.env` secrets.

---

## The daemon (the local app server)

The Airglow daemon serves this workspace: manifests, bundled userscripts and UI, RPC calls, and the browser bridge. It starts automatically while Chrome (with the Airglow extension) is running — there is nothing to start or configure. Its port is recorded in `~/.airglow/state/daemon.json` (default `3222`):

```bash
port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' ~/.airglow/state/daemon.json)
curl -sf "http://127.0.0.1:$port/api/healthz"
```

Endpoints (anything else 404s):

- `GET /api/apps/manifests` — all apps the daemon sees
- `GET /api/apps/<id>/userscript?file=<path>` — the bundled userscript, or a JSON error with a fix hint when the bundle fails
- `GET /api/apps/<id>/ui` — the app's UI page (open in the browser with `?app=<id>` appended)
- `POST /api/apps/<id>/rpc/<name>` — run `server/<name>.ts` with the JSON body
- `GET /api/healthz`

New apps are picked up automatically within a few seconds — no registration step. The daemon log (bundle errors, RPC failures) is at `~/.airglow/state/daemon.log`; the extension reloads matching tabs when userscripts change.

---

## Dependencies

Each app declares its own dependencies in its own `package.json` — the workspace root is a Bun workspace over `apps/*`:

```bash
cd apps/<id> && bun add <pkg>
```

The workspace root carries the shared baseline (react, react-dom, tailwindcss). A bundle error `Could not resolve <pkg>` means the app uses a package it doesn't declare.

---

## manifest.json

```json
{
  "id": "hn-tagger",
  "name": "HN Tagger",
  "version": "0.1.0",
  "description": "AI-generated tags for every HN title",
  "visibility": "public",

  "startup": "startup.ts",

  "userscripts": [
    { "file": "userscripts/hn.ts", "matches": ["*://news.ycombinator.com/*"] }
  ],

  "server_env": {
    "ANTHROPIC_API_KEY": { "label": "Anthropic API Key" }
  }
}
```

| Field | Purpose |
|---|---|
| `id` | Unique app id. Must equal the directory name. Used for storage namespacing and URL routing. |
| `name`, `version`, `description` | Shown in the extension dashboard. |
| `visibility` | `"public"` (default) or `"hidden"`. `hidden` apps are skipped entirely. |
| `defaultEnabled` | First-encounter default in the extension. When `false`, the extension starts the app disabled the first time it sees this `id`; after that the user's dashboard toggle is authoritative. Defaults to `true`. |
| `startup` | Path to a startup script. Runs once per extension boot. |
| `userscripts[]` | Each entry: `{ file, matches, allFrames?, runAt? }`. `matches` uses [Chrome match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns). `runAt` defaults to `"document_idle"`. |
| `secrets` | Client-scoped secrets the app needs. Each entry: `{ label, description? }`. Keys appear in the extension's Secrets UI labelled by `label`; the app page renders them as "Client keys" callouts, annotated with `description`. Values read via `airglow.storage.get('KEY')`. |
| `server_env` | Server-scoped env vars the app needs (API keys etc.). Each entry: `{ label, description? }`. Keys checked against the app's `apps/<id>/.env` and the daemon Secrets store; missing keys are reported by the daemon and the user is prompted to fill them in (labelled by `label`). The app page renders them as "Server keys" callouts, annotated with `description`. Values read via `process.env.KEY` from `server/*.ts` — they never reach browser code. Declarative only — not enforced. |

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

A React + Tailwind SPA the daemon serves at `/api/apps/<id>/ui`, which the extension dashboard embeds as a sandboxed iframe. Every app must ship one, built on the shared `AppPage` layout (`shared/components`) — see the "Every app ships an app page" rule in `AGENTS.md` for the required structure (name, description, injected-UI preview, settings).

```
package.json     # the app's own dependencies
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
@import "@shared/theme/tailwind-theme.css";
```

If `ui/globals.css` exists the daemon bundles Tailwind for the app; otherwise basic reset styles apply.

---

## Startup

`startup.ts` runs once per extension boot — on browser launch, on extension reload, and on extension update. It must be **idempotent**.

Access to `airglow.storage`, `airglow.log`, and `airglow.platform`; no DOM and no `airglow.fetch`. Use it for platform setup — iframe permissions.

```ts
// startup.ts
const domains = (await airglow.storage.get('framed_sites')) ?? ['notion.so'];
await airglow.platform.allowIframes(domains, ['example.com']);
```

---

## Server functions

The default export of `server/<name>.ts` becomes an RPC endpoint, callable from userscripts or UI via `airglow.rpc('<name>', payload)`. Use server functions for anything that needs to run on the machine or use real secrets.

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
- Node APIs work (`fs`, `crypto`, `child_process`, …) — they run under Bun on this machine. Packages must be declared in the app's `package.json`.
- Throw or return non-2xx to make `airglow.rpc()` reject.
- A server-side `airglow` global provides `llm`, `log`, and `connectors` (see [sdk-reference.md](sdk-reference.md)). Browser-bound APIs (`storage`, `fetch`, `captureTab`, `platform`) are client-only — pass whatever state a function needs as `airglow.rpc()` arguments.

---

## Secrets

Secrets are **server-only** — available as `process.env.FOO` from `server/*.ts`, never sent to the browser. Browser code that needs a key calls a server function via `airglow.rpc()` instead.

Declare required keys in `manifest.server_env`: missing keys are reported by the daemon at startup and surfaced to the user (dashboard Secrets UI + chat), who fills them in per app without touching files. UI-entered values are stored by the daemon in `state/secrets/<app-id>.env` — treat that directory as daemon-owned; never read or edit it.

For development, an `apps/<id>/.env` file works as a lower-precedence fallback:

```bash
# apps/<id>/.env — app-specific developer fallback
ANTHROPIC_API_KEY=sk-ant-...
NOTION_PAGE_ID=abc123
```

Resolution order per app: UI-entered value > `apps/<id>/.env`. There is no workspace-wide `.env` for server secrets. Changes apply on the next RPC call — no restart. Non-secret client-side state belongs in `airglow.storage`, not `.env`.

---

## Connectors: third-party tools (Gmail, Notion, Sheets, …)

`airglow.connectors` calls ~1000 third-party services (Composio-backed) with OAuth handled by the platform. No SDK to install, no API keys — calls route through the Airglow cloud, which requires the user to be signed in (errors with `CONNECTOR_SIGNIN_REQUIRED` otherwise). Developers can bypass the cloud by putting their own `COMPOSIO_API_KEY` (a personal project from app.composio.dev) in the workspace `.env` — the daemon then talks to Composio directly, no sign-in needed.

Discover toolkits (services) and tools (callable verbs, slugs like `GMAIL_FETCH_EMAILS`):

```bash
airglow toolkit search <query>           # find a toolkit (gmail, notion, googlesheets, …)
airglow toolkit tools <toolkit>          # list its tools
airglow toolkit schema <TOOL_SLUG>       # parameter schema for one tool
```

### The API

```ts
// Client (userscripts, UI) — connect() opens the OAuth popup and resolves once approved:
await airglow.connectors.connect('googlesheets');
const { connected } = await airglow.connectors.status('googlesheets');
await airglow.connectors.disconnect('googlesheets');

// Client AND server (server/*.ts) — execute a tool:
const result = await airglow.connectors.execute('GOOGLESHEETS_BATCH_GET', {
  spreadsheet_id: '...',
  ranges: ["'Sheet1'!A1:H100"],
});
// result: { data, successful, error }
```

The standard shape — server function checks, client connects:

```ts
// server/fetch-sheet.ts
export default async function fetchSheet(body: { spreadsheetId: string }) {
  const { connected } = await airglow.connectors.status('googlesheets');
  if (!connected) return { ok: false, needsAuth: true };
  const result = await airglow.connectors.execute('GOOGLESHEETS_BATCH_GET', {
    spreadsheet_id: body.spreadsheetId,
    ranges: ["'Sheet1'!A1:H100"],
  });
  return { ok: true, valueRanges: (result.data as any)?.valueRanges ?? [] };
}

// userscript
const resp = await airglow.rpc('fetch-sheet', { spreadsheetId });
if (resp?.needsAuth) {
  await airglow.connectors.connect('googlesheets'); // OAuth popup, resolves when approved
  // retry the rpc
}
```

- **Connections are scoped to your app.** Another app connecting Gmail does not give your app Gmail; each app shows its own consent popup once. The user reviews and removes connections in the dashboard Settings.
- **Multiple identities** on one service (e.g. two Google accounts) are separated by account labels: pass `{ account: userEmail }` as the last argument to any connectors call. Default label is `"default"`. For Google services, an email-shaped label preselects that account on the consent screen — but the label is a claim, not a verified identity; verify with a profile call (e.g. `GMAIL_GET_PROFILE`) when it matters.
- Result `data` shape varies per toolkit; sometimes nested under `response_data`.
- `connect()` is client-only (it opens a popup). Server functions get `execute`/`status`/`disconnect`.
- Test from the shell with an app's scope: `echo '{"query":"is:unread"}' | airglow toolkit exec GMAIL_FETCH_EMAILS --app <id>`.

---

## Gotchas

- **No `localStorage` / `IndexedDB`** — all UIs share an origin. Use `airglow.storage`.
- **No cross-app imports** — put shared code in `shared/` (copy it into your app to customize; `shared/` is overwritten on Airglow updates).
- **No `window.open()` in userscripts** — isolated `window`. Use `airglow.openWindow()`.
- **`startup.ts` must be idempotent** — it runs on every boot.
- **`server/` runs on the machine, not in the browser** — don't import `window`, `document`, `chrome.*`, or `react-dom`.
- **`airglow.fetch` return shape is limited** — `{ status, ok, json(), text() }`. For headers or streaming, use a server function with native `fetch`.
- **No API keys in browser code** — `.env` keys exist only in `server/*.ts` (`process.env`). Call key-using APIs through `airglow.rpc()`, or use `airglow.llm.anthropic.messages()` which needs no key at all.
