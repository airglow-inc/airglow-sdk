# Rules for Coding Agents to Develop Airglow Apps

You build Airglow apps in this workspace. Each direct subdirectory with a `manifest.json` is one app.

## Bootstrap (run at the start of EACH session)

Before any other work:

1. If `node_modules/` is missing, run `pnpm install`.
2. Run `pnpm airglow dev` in the background and keep it running. It's idempotent — exits 0 if a server is already up. If the port is taken by a non-airglow process, **stop and ask the user**; never kill processes. On a port change (`--port N`), the user must update the dev port in the extension dashboard themselves.

## Always read logs after editing an app

Failures (bundle, RPC, userscript runtime) will **not** surface in your tool output. After every edit, read both streams:

- **Dev server** — `tail -n 100 .airglow/dev.log`
- **Browser** — `curl -s 'localhost:3277/logs?level=error&n=50' | jq` (drop `level=error` for info/warn; add `source=<app-id>` to filter)

A clean tool output is not a signal that the change worked. Fix errors before claiming success.

## Docs

@docs/app-developer-guide.md — manifest, each app part, runtime contract
@docs/sdk-reference.md — the `airglow.*` SDK

Read [`docs/browser-debugging.md`](docs/browser-debugging.md) before driving the browser (`pnpm dom`: tabs, eval, screenshots, reload) or digging deeper into logs.

## Development structure

- **One app per directory**, `manifest.json` `id` == directory name. No cross-app imports — shared code goes in `shared/`.

- **Every app ships an app page.** `ui/App.tsx` is required (without it: blank `no UI entry found` page). Build it with the shared layout:

  ```tsx
  import { AppPage, SettingsSection, SettingField } from '../../shared/components';

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

  `ui/globals.css` must import `tailwindcss` and `../../shared/theme/tailwind-theme.css`.

- **`airglow.*` SDK only** — no `chrome.*` access anywhere.

- **Secrets in `.env`.** `CLIENT_*` keys reach browser code via `airglow.storage`; unprefixed keys are server-only (`process.env.FOO` in `server/*.ts`). Per-app `<app-id>/.env` overrides the workspace one.

## Best practices

- **Test end-to-end in the real browser** (`pnpm dom`). Untested code is not done; if something can't be tested, say so at the end of your response.

- **Verify the underlying API before wiring it in** — call it directly (script/`curl`/CLI), then `curl` the RPC, then the browser.

- **Never hardcode secrets.** Keys live in `.env`; a missing key should show a setup message, not crash. For one-off shell commands use `env $(cat .env | grep -v '^#' | xargs) <command>` instead of pasting keys.

- **Use the shared theme** — `shared/theme/tokens.css`.

- **Make React UIs test-driveable.** `data-testid` on every interactive element. `button.click()` works, but `input.value = x` does NOT update React state — expose a `window.__test` object (e.g. `{ selectGroup: setSelectedId }`) and call it via `pnpm dom eval --main`.

- **Use Composio (v3) for third-party APIs**, from `server/*.ts` only (its key is server-only). Look up tool schemas first: `pnpm composio <toolkit>` (list), `pnpm composio <toolkit> <TOOL_SLUG>` (schema).

## Verify before handoff

- `curl -sf http://127.0.0.1:3222/api/healthz` returns ok. If not, restart `pnpm airglow dev`; if still down, **notify the user — do not report success**.
- Your app appears in `curl -sf http://127.0.0.1:3222/api/apps/manifests`. If not, it's a failure.
- `manifest.json` valid; `id` matches the directory; every referenced file exists.
- `curl -sf http://127.0.0.1:3222/api/apps/<app-id>/ui` returns HTML, and settings read/write through `airglow.storage` in the extension (app-shell).
- Every `airglow.rpc('foo', ...)` has a matching default export in `server/foo.ts`.
- No keys or tokens hardcoded in `userscripts/` or `ui/`.
- Tested in the real browser, not just `curl`.
- **Screenshot the rendered page** (`pnpm dom shot`) and scan for layout bugs: overflow/clipping (especially the preview in the narrow rail), text spilling, a preview that doesn't match the real widget. A clean bundle with a wrong-looking page is wrong — fix before handoff.
