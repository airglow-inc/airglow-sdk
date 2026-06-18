# Rules for Coding Agents Building Airglow Apps

You build Airglow apps in this workspace. Each directory under `apps/` with a `manifest.json` is one app. The daemon serves the workspace automatically while Chrome (with the Airglow extension) is running — you never start, stop, or restart it.

## Bootstrap (each session)

1. Put the CLI on PATH: `export PATH="$HOME/.airglow/bin:$PATH"`.
2. Confirm the daemon is up:
   ```bash
   port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' ~/.airglow/state/daemon.json)
   curl -sf "http://127.0.0.1:$port/api/healthz"
   ```
   If it fails, ask the user to open Chrome with the Airglow extension enabled — never launch a browser process yourself.

## Always read logs after editing an app

The daemon runs silently — bundle failures, missing files, RPC errors, and uncaught userscript errors do **not** appear in your tool output. After every edit, check the logs before moving on:

- `airglow browser logs --level error -n 50` — merges both streams (browser: userscript/UI/startup runtime errors; daemon: bundle/RPC/startup errors), newest last. Drop `--level error` for info/warn; `--source <app-id>` filters to one app, `--source daemon` to the daemon log.

Clean output is not proof the change worked. Fix errors before claiming success.

## Interaction behavior (hard rules)

The browser belongs to the user; their open tabs are their workspace, not yours.

- Pure reads on the user's tabs are fine: `airglow browser tabs`, `html`, `logs`.
- **Every non-read operation happens in your own tabs.** Open the page yourself (`airglow browser open <url>` → separate agent window) and do all navigation, closing, and state-changing `eval` (click, type, scroll, submit) there — even if the right page is already open in a user tab.
- `shot` brings a window to the front — screenshot your own tabs; only a user tab when the task requires it.
- Never close tabs you didn't open. You cannot launch browsers; use the existing one. There is no reload command — the platform reloads matching tabs when you change app source.

## Docs

@docs/app-developer-guide.md — manifest, app parts, daemon endpoints, secrets, connectors
@docs/sdk-reference.md — the `airglow.*` SDK
@docs/browser-debugging.md — logs, `airglow browser`

## Structure

- **One app per directory under `apps/`.** `apps/<id>/manifest.json` with `id` == directory name. Apps don't import each other — shared code goes in `shared/`, imported via the `@shared/...` alias (never relative `../../shared`).
- **`shared/` and `docs/` are Airglow-managed** and force-overwritten on update. Customize by copying into your app, never by editing in place.
- **Each app owns its dependencies** in `apps/<id>/package.json` (`cd apps/<id> && bun add <pkg>`; run `bun install` after hand-edits; never touch `bun.lock`). Root carries react, react-dom, tailwindcss. `Could not resolve <pkg>` = undeclared dependency.
- **`airglow.*` SDK only** — no `chrome.*`.
- **Secrets are server-only** — `process.env.FOO` in `server/*.ts`, never in browser code; route key-using calls through `airglow.rpc()`. Declare keys in `manifest.server_env`. Never read or print secret values. See the guide's Secrets section.

## Every app ships an app page

`ui/App.tsx` is required (without it: blank `no UI entry found`). Build it on the shared layout:

```tsx
import { AppPage, SettingsSection, SettingField } from '@shared/components';

<AppPage appId="my-app" name="My App" description="What the app does."
         preview={<MyInjectedWidgetMock />}>
  {/* settings via SettingsSection / SettingField */}
</AppPage>
```

`AppPage` renders the standard sidebar: `children` (settings) in a wide left column, `preview` + secret callouts in a sticky right rail (~340px). Don't wrap `children` in your own `max-w-*`. The page must include:

- **name** and **description**;
- a **preview** when the app injects UI into pages — a *static* JSX mock with styles copied verbatim from the userscript, always showing the entry point (button/pill). Make it fluid: `width: 100%` + `maxWidth`, rows `flex-wrap`, never overflow the rail;
- **settings for every app-specific constant**, persisted via `airglow.storage` so userscripts pick them up;
- secret callouts render automatically from `manifest.secrets` / `manifest.server_env` — declare every key there (with optional `description`); don't list keys on the page.

`ui/globals.css` must import `tailwindcss` and `@shared/theme/tailwind-theme.css`. Use the shared theme (`shared/theme/tokens.css`).

## Best practices

- **Test end-to-end against a real browser** — untested code is not done. Drive it with `airglow browser` (see `docs/browser-debugging.md`). If you can't test something, say so at the end.
- **Verify the underlying API before wiring it in** — call it directly (script/`curl`/CLI), then the RPC, then the browser.
- **Make React UIs test-driveable** — `data-testid` on interactive elements. `button.click()` works; `input.value = x` does NOT update React state, so expose a `window.__test` object and call it with `airglow browser eval --main`:
  ```tsx
  useEffect(() => {
    (window as any).__test = { selectGroup: (id: string) => setSelectedId(id), runCompare: () => handleCompare() };
  }, []);
  ```
- **Use `airglow.connectors` for third-party APIs** (Gmail, Notion, Sheets, …) over hand-rolled clients with secret keys. Look up schemas first: `airglow toolkit tools <toolkit>`, `airglow toolkit schema <TOOL_SLUG>`.

## Verify before handoff

- App appears in `curl -sf "http://127.0.0.1:$port/api/apps/manifests"`. If not, it's a failure — check `daemon.log`.
- `manifest.json` valid; `id` == directory; every referenced file exists.
- Every `airglow.rpc('foo', ...)` has a matching default export in `server/foo.ts`.
- No keys/tokens hardcoded in `userscripts/` or `ui/`.
- Tested in the real browser, not just `curl`.
- **Screenshot the rendered page** (`airglow browser shot`) and scan for layout bugs: overflow/clipping (especially the preview in the narrow rail), text spilling, a preview that doesn't match the real widget. A clean bundle with a wrong-looking page is still wrong.
