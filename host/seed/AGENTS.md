# Rules for Coding Agents to Develop Airglow Apps

You build Airglow apps in this workspace. Each directory under `apps/` with a `manifest.json` is one app. The daemon serves this workspace automatically while Chrome (with the Airglow extension) is running — you never start or restart it.

## Bootstrap (start of EACH session)

1. Put the Airglow CLI on PATH: `export PATH="$HOME/.airglow/bin:$PATH"`.
2. Confirm the daemon is up:
   ```bash
   port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' ~/.airglow/state/daemon.json)
   curl -sf "http://127.0.0.1:$port/api/healthz"
   ```
   The daemon is the local app server — it bundles apps, runs server functions, and bridges the browser. It starts automatically while Chrome (with the Airglow extension) is running; you never start, stop, or restart it. If the health check fails, ask the user to open Chrome with the Airglow extension enabled — never launch a browser process yourself.

## Always read logs after editing an app

The daemon runs silently — bundle failures, missing files, RPC errors, and uncaught userscript errors will **not** surface in your tool output. After every edit to an app (userscript, UI, startup, server function, manifest, or `.env`), read both log streams before moving on:

- **Daemon** (bundle errors, RPC failures, startup errors) — `tail -n 100 ~/.airglow/state/daemon.log`
- **Browser** (userscript / UI / startup runtime errors, `airglow.log.*`) — `airglow browser logs --level error -n 50`. Drop `--level error` to see info/warn too; add `--source <app-id>` to filter to one app.

A clean tool output is not a signal that the change worked. Fix errors before claiming success.

## Interaction behavior (hard rules)

The browser belongs to the user; their open tabs are their workspace, not yours.

- Pure reads are allowed on the user's existing tabs: `airglow browser tabs`, `html`, `logs`.
- **Every non-read operation happens in your own tabs only**: open the page yourself (`airglow browser open <url>` — it lands in a separate agent window) and do all navigation, closing, and any eval that clicks, types, scrolls, submits, or otherwise changes page or app state there. Never drive a tab the user opened, even if the right page is already open in one — open your own copy.
- Screenshots bring the tab's window to the front: screenshot your own tabs; only screenshot a user tab when the task explicitly requires it.
- Never close tabs you didn't open.
- You cannot launch browser processes; use the existing browser only. There is no reload command — the platform reloads matching tabs automatically when you change an app's source.

## Docs

@docs/app-developer-guide.md — manifest, each app part, runtime contract
@docs/sdk-reference.md — the `airglow.*` SDK
@docs/browser-debugging.md — logs, `airglow browser` for driving the browser

## Development structure

- **One app per directory under `apps/`.** Each app lives in `apps/<id>/` with a `manifest.json` whose `id` matches the directory name. Apps shouldn't import from each other — shared code goes in `shared/`, imported via the `@shared/...` alias (never relative `../../shared` paths).

- **`shared/` and `docs/` are managed by Airglow** and force-overwritten on update. Customize by copying into your app, never by editing them in place.

- **Each app declares its own dependencies** in `apps/<id>/package.json`: `cd apps/<id> && bun add <pkg>`. Editing package.json by hand also works, but run `bun install` afterward — nothing installs automatically; never edit `bun.lock`. The workspace root carries the shared baseline (react, react-dom, tailwindcss). A bundle error `Could not resolve <pkg>` means exactly this — a missing declaration.

- **Every app ships an app page.** `ui/App.tsx` is required (without it: blank `no UI entry found` page). Build it with the shared layout:

  ```tsx
  import { AppPage, SettingsSection, SettingField } from '@shared/components';

  <AppPage appId="my-app" name="My App" description="What the app does."
           preview={<MyInjectedWidgetMock />}>
    {/* settings */}
  </AppPage>
  ```

  `AppPage` renders the standard sidebar; `children` (settings) get a wide left column, the `preview` and secret callouts (derived from the manifest) a sticky right rail. Don't wrap `children` in your own `max-w-*`; use `SettingsSection`/`SettingField`. The page must include:
  - the app **name** and a **description**;
  - a **preview** when the app injects UI into websites: a *static* JSX mock, styles copied verbatim from the userscript. Always show the entry point (button/pill) when one exists, optionally plus a compact glimpse of what it opens. **Make it fluid** — the rail is ~340px, so replace fixed widths with `width: 100%` + `maxWidth`, let rows `flex-wrap`, never let it overflow;
  - **settings for every app-specific constant**, persisted via `airglow.storage` so userscripts pick them up;
  - secret callouts render automatically from `manifest.secrets` (client) and `manifest.server_env` (server) — don't list keys on the page; declare every key the app reads in the manifest, with an optional `description` per entry.

  `ui/globals.css` must import `tailwindcss` and `@shared/theme/tailwind-theme.css`.

- **`airglow.*` SDK only.** All app code talks to the platform through the SDK. There is no `chrome.*` access.

- **Secrets are server-only.** Keys are available as `process.env.FOO` inside `server/*.ts` and never reach browser code — anything needing a key goes through `airglow.rpc()` to a server function. Declare required keys in `manifest.server_env`: the daemon reports missing ones and the user is prompted to fill them in per app (stored daemon-side in `state/secrets/`, which you must never read or edit). `apps/<id>/.env` is the developer-level fallback; per-app resolution is UI-entered value > `apps/<id>/.env` (no workspace-wide `.env`). Never read or print secret values — to check which keys exist, list names only: `grep -hoE '^[A-Z][A-Z0-9_]*' apps/*/.env`.

## Best practices

- **Test end-to-end against a real browser.** Treat untested code as not done. Drive the user's browser with `airglow browser` — see `docs/browser-debugging.md`. If you can't test some part, notify the user at the end of your response.

- **Verify the underlying API before wiring it in** — call it directly (script/`curl`/CLI), then `curl` the RPC, then the browser.

- **Never hardcode secrets.** API keys, OAuth tokens, and other credentials go in `.env`, read via `process.env` in server functions only — never in `userscripts/` or `ui/`. If a required key is missing, the app should show a setup message — not crash. For one-off shell commands, inject `.env` vars without echoing them: `env $(grep -v '^#' .env | xargs) <command>`.

- **Use the shared theme** — `shared/theme/tokens.css`.

- **Make React UIs test-driveable.** Put `data-testid` on every interactive element. `button.click()` works (React picks it up via root delegation), but `input.value = x` does NOT update React state — expose a `window.__test` object for inputs and selects, and call it with `airglow browser eval --main` (the `--main` flag reaches page globals; see `docs/browser-debugging.md`):
  ```tsx
  useEffect(() => {
    (window as any).__test = {
      selectGroup: (id: string) => setSelectedId(id),
      runCompare: () => handleCompare(),
    };
  }, []);
  ```

- **Use `airglow.connectors` for third-party APIs** (Gmail, Notion, Sheets, …) — platform-managed OAuth, no SDK or per-app key; see docs/sdk-reference.md. Before calling an unfamiliar tool, look up its parameter schema:
  ```bash
  airglow toolkit tools <toolkit>          # list tools
  airglow toolkit schema <TOOL_SLUG>       # parameter schema for one tool
  ```

## Verify before handoff

- **Confirm the daemon is serving your app.** Run the health check from Bootstrap, then `curl -sf "http://127.0.0.1:$port/api/apps/manifests"` and verify your app appears in the response. If it doesn't, **it's a failure** — check `~/.airglow/state/daemon.log`. New apps are picked up automatically within a few seconds; there is no registration step.
- `manifest.json` is valid; `id` matches the directory; every referenced file exists.
- Every `airglow.rpc('foo', ...)` has a matching default export in `server/foo.ts`.
- No keys or tokens hardcoded in `userscripts/` or `ui/`.
- Tested in the real browser, not just `curl`.
- **Screenshot the rendered page** (`airglow browser shot`) and scan for layout bugs: overflow/clipping (especially the preview in the narrow rail), text spilling, a preview that doesn't match the real widget. A clean bundle with a wrong-looking page is wrong — fix before handoff.
