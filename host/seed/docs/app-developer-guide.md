# Airglow app developer guide

An Airglow app is a directory under `apps/` with a `manifest.json` plus any of four optional parts:

- **Userscripts** — JS/TS injected into matching web pages
- **UI** — a React + Tailwind app page, embedded in the extension dashboard
- **Startup** — code that runs once per browser launch
- **Server functions** — functions on this machine, called from userscripts/UI via RPC

All four use the `airglow.*` SDK ([`sdk-reference.md`](sdk-reference.md)); there is no `chrome.*`. Server functions also get Node APIs (under Bun) and `.env` secrets via `process.env`.

---

## The daemon

The daemon serves this workspace (manifests, bundled code, RPC, browser bridge). It starts automatically while Chrome with the Airglow extension is running — nothing to start or configure. New apps are picked up within a few seconds; no registration step. Port is in `~/.airglow/state/daemon.json` (default `3222`):

```bash
port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' ~/.airglow/state/daemon.json)
```

Endpoints (anything else 404s):

| Method | Path | Returns |
|---|---|---|
| GET | `/api/healthz` | liveness |
| GET | `/api/apps/manifests` | all apps the daemon sees |
| GET | `/api/apps/<id>/userscript?file=<path>` | bundled userscript, or a JSON error with a fix hint on bundle failure |
| GET | `/api/apps/<id>/ui` | the app's UI page (append `?app=<id>` when opening in a browser) |
| POST | `/api/apps/<id>/rpc/<name>` | runs `server/<name>.ts` with the JSON body |

Bundle errors and RPC failures go to `~/.airglow/state/daemon.log` — they do not surface in tool output. Read it after editing.

---

## Dependencies

Each app declares its own dependencies in its own `package.json` (the workspace root is a Bun workspace over `apps/*`):

```bash
cd apps/<id> && bun add <pkg>
```

Editing `package.json` by hand also works — run `bun install` after; nothing installs automatically. Never edit `bun.lock`. The root carries the shared baseline (react, react-dom, tailwindcss). A bundle error `Could not resolve <pkg>` means the package isn't declared.

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

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Unique app id; must equal the directory name. Namespaces storage and URL routing. |
| `name`, `version`, `description` | string | Shown in the dashboard. |
| `visibility` | `"public"` \| `"hidden"` | `hidden` apps are skipped entirely. Default `"public"`. |
| `defaultEnabled` | boolean | First-encounter default. `false` starts the app disabled the first time this `id` is seen; the user's toggle is authoritative after. Default `true`. |
| `startup` | string | Path to a startup script; runs once per extension boot. |
| `userscripts[]` | array | `{ file, matches, allFrames?, runAt?, world? }`. `matches` uses [Chrome match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns); `runAt` defaults to `"document_idle"`; `world` defaults to `"USER_SCRIPT"` (`"MAIN"` runs in the page realm — see Userscripts below). |
| `secrets` | object | Client-scoped secrets. Each entry `{ label, description? }`. Surfaced in the Secrets UI and as "Client keys" callouts; read via `airglow.storage.get('KEY')`. |
| `server_env` | object | Server-scoped env vars. Each entry `{ label, description? }`. Missing keys are reported by the daemon and prompted per app; read via `process.env.KEY` in `server/*.ts` only. Declarative — not enforced. |

---

## Userscripts

Files under `manifest.userscripts[]`, registered via `chrome.userScripts.register()` in the `USER_SCRIPT` world: full DOM access, isolated `window`, no `chrome.*`. Requires "Allow User Scripts" on the extension (Chrome 138+).

```ts
// userscripts/hn.ts
const titles = document.querySelectorAll('.titleline > a');
// call airglow.fetch / airglow.storage / airglow.rpc
```

### `world: "MAIN"`

`"world": "MAIN"` runs a userscript in the page's own realm — needed to patch page globals (`window.fetch`, `WebSocket`, event handlers) or to run under a strict CSP that blocks injected scripts. A MAIN-world script has **no `airglow.*`** and shares the page's globals, so keep DOM/UI/SDK work in a separate default-world script.

---

## UI

A React + Tailwind SPA served at `/api/apps/<id>/ui`, embedded by the dashboard as a sandboxed iframe. Every app ships one, built on the shared `AppPage` layout — see the "Every app ships an app page" rule in `AGENTS.md` for the required structure (name, description, injected-UI preview, settings).

```
ui/
  App.tsx        # entry, self-mounts into #root
  globals.css    # imports the shared theme (optional)
```

```tsx
// ui/App.tsx
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [logs, setLogs] = useState([]);
  useEffect(() => { airglow.storage.get('logs').then(setLogs); }, []);
  return <div className="p-4">{logs.map(l => <div key={l.ts}>{l.ts} — {l.message}</div>)}</div>;
}
createRoot(document.getElementById('root')!).render(<App />);
```

```css
/* ui/globals.css */
@import "tailwindcss";
@import "@shared/theme/tailwind-theme.css";
```

With `ui/globals.css` the daemon bundles Tailwind for the app; without it, basic reset styles apply.

---

## Startup

`startup.ts` runs once per extension boot (launch, reload, update) and must be **idempotent**. Has `airglow.storage`, `airglow.log`, `airglow.platform`; no DOM, no `airglow.fetch`. Use it for platform setup like iframe permissions.

```ts
const domains = (await airglow.storage.get('framed_sites')) ?? ['notion.so'];
await airglow.platform.allowIframes(domains, ['example.com']);
```

---

## Server functions

The default export of `server/<name>.ts` is an RPC endpoint, callable via `airglow.rpc('<name>', body)`. Runs on the user's machine with Node APIs and real secrets.

```ts
// server/tag.ts
export default async function (body: { titles: string[] }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return { tags: [/* ... */] };
}
```

- `body` is the `airglow.rpc()` payload; the return value is JSON-serialized.
- Throw or return non-2xx to make `airglow.rpc()` reject.
- Node APIs (`fs`, `crypto`, `child_process`, …) work; packages must be declared in the app's `package.json`.
- A server-side `airglow` global provides `llm`, `log`, `connectors`. Browser-only APIs (`storage`, `fetch`, `captureTab`, `platform`) are not available — pass what a function needs as arguments.

---

## Secrets

Server-only: available as `process.env.FOO` in `server/*.ts`, never sent to the browser. Browser code that needs a key calls a server function instead.

Declare keys in `manifest.server_env`. Missing keys are reported by the daemon and surfaced to the user (dashboard + chat) to fill in per app; UI-entered values are stored in `state/secrets/<app-id>.env` — daemon-owned, never read or edit. `apps/<id>/.env` is a lower-precedence developer fallback. Resolution per app: UI-entered value > `apps/<id>/.env`. No workspace-wide `.env`. Changes apply on the next RPC call.

```bash
# apps/<id>/.env — developer fallback
ANTHROPIC_API_KEY=sk-ant-...
```

Never hardcode keys; never read or print secret values. To check which keys exist, list names only:

```bash
grep -hoE '^[A-Z][A-Z0-9_]*' .env */.env
```

---

## Connectors: third-party tools (Gmail, Notion, Sheets, …)

`airglow.connectors` calls ~1000 services (Composio-backed) with OAuth handled by the platform — no SDK, no API keys. Calls route through the Airglow cloud, which needs the user signed in (else `CONNECTOR_SIGNIN_REQUIRED`). Dev bypass: put your own `COMPOSIO_API_KEY` (from app.composio.dev) in the workspace `.env` to talk to Composio directly.

Discover toolkits (services) and tools (slugs like `GMAIL_FETCH_EMAILS`):

```bash
airglow toolkit search <query>           # find a toolkit
airglow toolkit tools <toolkit>          # list its tools
airglow toolkit schema <TOOL_SLUG>       # parameter schema for one tool
```

### API

```ts
// client (userscripts, UI):
await airglow.connectors.connect('googlesheets');                      // OAuth popup, resolves on approval
const { connected } = await airglow.connectors.status('googlesheets');
await airglow.connectors.disconnect('googlesheets');

// client AND server:
const result = await airglow.connectors.execute('GOOGLESHEETS_BATCH_GET', {
  spreadsheet_id: '...', ranges: ["'Sheet1'!A1:H100"],
});
// → { data, successful, error }
```

Standard shape — server checks, client connects:

```ts
// server/fetch-sheet.ts
export default async function (body: { spreadsheetId: string }) {
  const { connected } = await airglow.connectors.status('googlesheets');
  if (!connected) return { ok: false, needsAuth: true };
  const result = await airglow.connectors.execute('GOOGLESHEETS_BATCH_GET', {
    spreadsheet_id: body.spreadsheetId, ranges: ["'Sheet1'!A1:H100"],
  });
  return { ok: true, valueRanges: (result.data as any)?.valueRanges ?? [] };
}

// userscript
const resp = await airglow.rpc('fetch-sheet', { spreadsheetId });
if (resp?.needsAuth) { await airglow.connectors.connect('googlesheets'); /* retry */ }
```

Assumptions that matter:

- **Connections are per app** — another app connecting Gmail doesn't grant yours; each app prompts its own consent once.
- **Multiple identities** on one service: pass `{ account: userEmail }` as the last arg. Default label `"default"`. An email-shaped label preselects that account on Google's consent screen, but it's a claim, not verified — confirm with a profile call (e.g. `GMAIL_GET_PROFILE`) when identity matters.
- `data` shape varies per toolkit (sometimes nested under `response_data`).
- `connect()` is client-only (opens a popup); server functions get `execute`/`status`/`disconnect`.
- Test from the shell in an app's scope: `echo '{"query":"is:unread"}' | airglow toolkit exec GMAIL_FETCH_EMAILS --app <id>`.

---

## Gotchas (where reasonable assumptions break)

- **No `localStorage` / `IndexedDB`** — all UIs share one origin. Use `airglow.storage`.
- **No cross-app imports** — shared code goes in `shared/` (copy into your app to customize; `shared/` is overwritten on updates).
- **No `window.open()` in userscripts** — isolated `window`. Use `airglow.openWindow()`.
- **`startup.ts` runs on every boot** — keep it idempotent.
- **`server/` runs on the machine, not the browser** — no `window`, `document`, `chrome.*`, or `react-dom`.
- **`airglow.fetch` response is limited** — `{ status, ok, json(), text() }`. For headers or streaming, use a server function with native `fetch`.
- **No API keys in browser code** — `.env` keys exist only in `server/*.ts`. Use `airglow.rpc()`, or `airglow.llm.chat()` (no key needed).
