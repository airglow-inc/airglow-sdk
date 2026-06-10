# Rules for Coding Agents to Develop Airglow Apps

You build Airglow apps in this workspace. Each direct subdirectory with a `manifest.json` is one app.

## Bootstrap (run this at the start of EACH session)

Before any other work in this workspace, you **must**:

1. Check if `node_modules/` is missing. If so, run `pnpm install`.
2. Run `pnpm airglow dev` in the background.
   - The command is idempotent: if a dev server is already up it exits 0 immediately.
   - If the port is taken by a non-airglow process, **stop and ask the user** what to do. Never kill processes on your own. If the user chooses to change the port, you can pass `--port N` to `pnpm airglow dev`, but the matching dev-port update in the extension dashboard must be done by the user manually — ask them to do it.
   - Keep the server running for the rest of the session.

## Always read logs after editing an app

The dev server keeps running silently — bundle failures, missing files, RPC errors, and uncaught userscript errors will **not** surface in your tool output. After every edit to an app (userscript, UI, startup, server function, manifest, or `.env`), read both log streams before moving on:

- **Dev server** (bundle errors, RPC failures, startup errors) — `tail -n 100 .airglow/dev.log`. Truncated each `pnpm airglow dev` run.
- **Browser** (userscript / UI / startup runtime errors, `airglow.log.*`) — `curl -s 'localhost:3277/logs?level=error&n=50' | jq`. Drop `level=error` to see info/warn too; add `source=<app-id>` to filter to one app.

A clean tool output is **not** a signal that the change worked. If either stream shows an error related to your change, fix it before claiming success. See [`docs/browser-debugging.md`](docs/browser-debugging.md) for more options.

## Docs

@docs/app-developer-guide.md — manifest, each app part, runtime contract
@docs/sdk-reference.md — the `airglow.*` SDK
@docs/browser-debugging.md — logs, `pnpm dom` for driving the browser

## Development structure

- **One app per directory.** Each app lives in its own directory at the workspace root, with a `manifest.json` whose `id` matches the directory name. Apps shouldn't import from each other — shared code goes in `shared/`.

- **Every app ships an app page.** `ui/App.tsx` is required — it's what users see when they click the app in the extension dashboard (without it they get a blank `no UI entry found` error page). Build it with the shared layout so all apps look native to Airglow:

  ```tsx
  import { AppPage, SettingsSection, SettingField } from '../../shared/components';

  <AppPage
    appId="my-app"                       // must equal the manifest id
    name="My App"
    description="One or two sentences on what the app does."
    preview={<MyInjectedWidgetMock />}   // optional — see below
    secrets={[{ name: 'ANTHROPIC_API_KEY' }]}  // optional — see below
  >
    {/* app-specific settings/content */}
  </AppPage>
  ```

  `AppPage` renders the standard dashboard-style sidebar (Airglow logo, Cloud Apps, Local Apps, Settings) and lays the content out to fill the page: your `children` (the settings) get a wide left column, while the `preview` and `secrets` go in a sticky right rail. Let your content fill that column — don't wrap `children` in your own narrow `max-w-*`, and use `SettingsSection`/`SettingField` so it matches the layout. The page must include:
  - the **app name** and a **description** of what the app does;
  - a **preview** when the app injects UI into websites: a small *static* JSX mock — no live logic. Copy the styles verbatim from the userscript so it matches the real thing. Always show the **entry point** (button/pill) when one exists — that's what users must find on the page — and optionally a compact glimpse of what it opens when that UI is the app's real substance. Apps with no entry point (shortcut- or CSS-triggered) show their injected UI directly. **Make the preview fluid:** it renders in the narrow (~340px), sticky right rail, so a real-page widget copied verbatim will overflow if you keep its fixed pixel width. Replace fixed widths with `width: 100%` + `maxWidth`, let rows `flex-wrap`, and clip nothing — never let the mock bleed outside its container;
  - **settings for every app-specific constant** (thresholds, URLs, domain lists, …), persisted via `airglow.storage` so the userscripts pick them up — use `SettingsSection`/`SettingField`;
  - required client secrets listed in the **`secrets` prop** — they render as read-only callouts (secrets are managed in the extension's Secrets page, never stored by the page itself). Server-only keys (e.g. a Composio key) get a callout with a note that they live in `.env`.

  `ui/globals.css` must import `tailwindcss` and `../../shared/theme/tailwind-theme.css`.

- **`airglow.*` SDK only.** All app code talks to the extension through the SDK. There is no `chrome.*` access.

- **Secrets in `.env`.** `CLIENT_*` keys are exposed to browser code through `airglow.storage`; unprefixed keys are server-only, available as `process.env.FOO` inside `server/*.ts`. A per-app `<app-id>/.env` overrides the workspace one.

## Best practices

- **Test end-to-end against a real browser.** Treat untested code as not done. Drive the user's browser with `pnpm dom` — see `docs/browser-debugging.md`. If you can't test some part, notify the user at the end of your response.

- **Verify the underlying API before wiring it in.** Call it directly first — via script, `curl`, or CLI — to confirm the request and response shape. If it lives behind a server function, `curl` the RPC next. Only then exercise the full app in the browser.

- **Never hardcode secrets.** API keys, OAuth tokens, and other credentials go in `.env`. Browser code reads via `airglow.storage`; server code reads via `process.env`. If a required key is missing, the app should show a setup message — not crash. For one-off shell commands, inject `.env` vars via `env $(cat .env | grep -v '^#' | xargs) <command>` rather than pasting keys into the command line.

- **Use the shared theme.** `shared/theme/tokens.css` defines the color palette and typography that you can start with.

- **Make React UIs test-driveable.** Put `data-testid` on every interactive element. `button.click()` works (React picks it up via root delegation), but `input.value = x` does NOT update React state — expose a `window.__test` object for inputs and selects, and call it with `pnpm dom eval --main` (the `--main` flag reaches page globals; see `docs/browser-debugging.md`):
  ```tsx
  useEffect(() => {
    (window as any).__test = {
      selectGroup: (id: string) => setSelectedId(id),
      runCompare: () => handleCompare(),
    };
  }, []);
  ```

- **Use Composio (v3) for third-party APIs.** Only call `@composio/core` from `server/*.ts` — its API key is server-only. Before calling an unfamiliar tool, look up its parameter schema:
  ```bash
  pnpm composio <toolkit>                # list tools
  pnpm composio <toolkit> <TOOL_SLUG>    # parameter schema for one tool
  ```

## Verify before handoff

- **Confirm the dev server is running.** Run `curl -sf http://127.0.0.1:3222/api/healthz` and verify it returns `{"ok":true,"service":"airglow-dev",...}`. 
  - If it doesn't respond, restart it with `pnpm airglow dev` in the background — the user expects the app to be loadable in the browser the moment you hand off. 
  - If server is still down, **immediately notify the user, do not report success**.
- **Confirm the manifests endpoint works.** Run `curl -sf http://127.0.0.1:3222/api/apps/manifests` and verify your app appears in the response. If it doesn't, **it's a failure**.
- `manifest.json` is valid; `id` matches the directory; every referenced file exists.
- **The app page works.** `curl -sf http://127.0.0.1:3222/api/apps/<app-id>/ui` returns HTML (not the `no UI entry found` error), and the page's settings read/write through `airglow.storage` when opened via the extension (app-shell).
- Every `airglow.rpc('foo', ...)` has a matching default export in `server/foo.ts`.
- No API keys or tokens are hardcoded in `userscripts/` or `ui/`.
- The app has been tested in the real browser, not just through `curl`.
- **Look at the rendered app page — a clean bundle is not a correct UI.** Open it in the extension (`app-shell.html?app=<id>`) and **screenshot it** (`pnpm dom shot`). Scan for layout bugs you can't catch from code: anything overflowing or clipped (especially the preview in the narrow right rail), text spilling its container, broken wrapping, or a preview that doesn't match the real injected widget. If the bundle compiles but the page looks wrong, it is wrong — fix it before handoff.
