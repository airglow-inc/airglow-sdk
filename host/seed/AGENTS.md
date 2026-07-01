# Rules for Coding Agents Building Airglow Apps

You build Airglow apps in this workspace. Each directory under `apps/` with a `manifest.json` is one app. The daemon serves the workspace automatically while Chrome (with the Airglow extension) is running — you never start, stop, or restart it.

## Bootstrap (each session)

1. Confirm the `airglow` CLI is on PATH — `command -v airglow`. The installer adds it; if that comes back empty (an agent that doesn't load your shell profile), put it on PATH for this session: `export PATH="$HOME/.airglow/bin:$PATH"`.
2. Confirm the daemon is up:
   ```bash
   port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' ~/.airglow/state/daemon.json)
   curl -sf "http://127.0.0.1:$port/api/healthz"
   ```
   In Codex, sandboxed shells may block even loopback networking. If `curl` exits 7 / `CURLE_COULDNT_CONNECT` but the same URL works outside Codex, request/enable network access for the command and retry; do **not** infer that the daemon is down from a sandbox-blocked socket. If it still fails with network access, ask the user to open Chrome with the Airglow extension enabled — never launch a browser process yourself.

## Always read logs after editing an app

The daemon runs silently — bundle failures, missing files, RPC errors, uncaught userscript errors, and **type errors** do **not** appear in your tool output (the daemon transpiles without type-checking). After every edit, check both before moving on:

- `npx tsc --noEmit 2>&1 | grep apps/<id>/` — type-check your app (the check spans the whole workspace; scope it to your app). Don't silence it with `declare const airglow: any` — the SDK global is already typed via `airglow.d.ts`. See `docs/browser-debugging.md`.
- `airglow browser logs --level error -n 50` — merges both streams (browser: userscript/UI/startup runtime errors; daemon: bundle/RPC/startup errors), newest last. Drop `--level error` for info/warn; `--source <app-id>` filters to one app, `--source daemon` to the daemon log.

Clean logs are not proof the change works — they only mean nothing crashed. Before claiming success, exercise what you changed end-to-end, **both layers**:

- **Server / RPC** — call the affected function for real and check its actual return: `curl … /rpc/<fn>` (see `docs/browser-debugging.md`) or `airglow browser eval --app <id> 'await airglow.rpc("<fn>", {…})'`. If localhost `curl` is blocked by the shell sandbox, prefer the `airglow browser eval --app` path instead of skipping the RPC check.
- **UI / userscript** — drive it in the real browser, then `airglow browser shot` and **read** the screenshot — confirm the new behavior, not just that the page loads. Test an app **UI** with `airglow browser open --app <id>` — it opens the UI fully wired (`airglow.*` live, via the `app-ui-bridge` content script) as a top-level tab, so `eval`/`html`/`shot` read it directly (no `--frame`). Don't `curl` that URL (unwired outside the extension — render-gated UIs hang) or test via the dashboard `chrome-extension://` page (its app iframe is cross-origin; `eval --frame` can't reach it). See `docs/browser-debugging.md`.

Reading logs is not testing. A change you didn't exercise is not done — if you genuinely can't test something, say so explicitly at the end.

## Interaction behavior (hard rules)

The browser belongs to the user; their open tabs are their workspace, not yours.

- Pure reads on any tab are fine: `airglow browser tabs`, `html`, `eval` to inspect, `shot`, `logs`.
- **Every non-read operation happens in your own tabs.** Open the page yourself (`airglow browser open <url>`) and do all navigation, closing, and state-changing `eval` (click, type, scroll, submit) there — even if the right page is already open in a user tab.
- **Your tabs live in your own window.** Your first `open` creates a dedicated, unfocused window (a colored "Airglow" tab group); every later `open` reuses it. In `tabs`, that window is `role: agent` — `agent-other` is another agent's window (off-limits) and `user` is the user's. Never open into a window you don't own.
- A tab runs un-throttled only while it's the active tab in its window; the tools activate your own tab before acting on it (without bringing the window to the front), so you don't need to manage focus — just work one tab at a time.
- `shot` captures in place (no focus change). Screenshot your own tabs; a user tab only when the task requires it.
- **Close your test tabs** (`close --tab N`) when you're done. Never close tabs you didn't open. You cannot launch browsers; use the existing one. There is no reload command — the platform reloads matching tabs when you change app source.

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

**Declare the page entrypoint.** When the app injects a clickable entrypoint (button/pill) into the page, set `manifest.entrypoint` to `{ "selector": "<css-selector>" }` — the exact selector your userscript creates for that element (e.g. `"#airglow-cinema-button"`). Airglow briefly highlights it on the page after a build so the user can find what changed. Give the entrypoint a stable, unique `id` (prefix with `airglow-`) and use that as the selector. Omit `entrypoint` for apps with no clickable entrypoint (pure-CSS, shortcut-only).

## Design: decide, don't default

AI UI drifts to the median — generic purple pill, system-font card, centered hero. An Airglow app has two design surfaces, each with a constraint median design ignores. Make an explicit call for each; if you can't name why a choice fits, it's a default, not a decision.

**Injected on-page UI** (buttons, pills, overlays your userscript adds to a host site) — the host's design *is* your design system:

- **Harmonize or contrast on purpose.** Read the host's own controls — accent color, pill radius, font, spacing (`getComputedStyle` an adjacent element) — then either match them so your element looks native, or contrast deliberately so it reads as "an Airglow tool." A purple pill dropped onto a site that uses none of those is neither — it's the default. (If X's search box is 44px tall with a given radius, a button beside it reasons from *that*, not a blank canvas.)
- **Minimal footprint.** You're a guest in someone's layout: one injected control, one accent, the host's spacing. Don't redecorate the room.
- **Don't fight the host.** Stacking/z-index, reflow, and not breaking the page come first; the visual follows what's safe. Re-assert your inline styles across the host's re-renders (it's usually a SPA) rather than styling once.
- **Respect `prefers-reduced-motion`.** Gate every transition/animation you add — `@media (prefers-reduced-motion: reduce)` removes it. Interaction motion <200ms, `ease-out` for entrances.

**The app page** (`ui/App.tsx`) — the opposite constraint: it lives in the shared dashboard, so consistency beats identity.

- Build on `@shared` `AppPage` + theme tokens (`var(--fg-primary)`, …). Don't invent a per-app palette or display font — that fragments the catalog. (Tailwind utility classes can fail to generate in an app bundle, rendering as zero padding; inline styles + theme tokens are the reliable path.)
- Within those tokens still hold the line: a real type scale, named color *roles* (background / surface / text / accent / muted), one accent used with restraint, a consistent radius set.
- **Real copy.** Name what the app actually does; no "unlock / elevate / seamless / supercharge," no "Your feature here."

**Airglow kill list** — revise the choice if you hit one:

- [ ] Generic SaaS purple/blue pill that ignores the host site's design language
- [ ] Animation with no `prefers-reduced-motion` fallback
- [ ] Injected control styled once, then wiped by the host's re-render
- [ ] App page that abandons `@shared` tokens for a one-off look
- [ ] Copy with "unlock / elevate / seamless / cutting-edge"

The screenshot scan under **Verify before handoff** is where you judge the result — read it as an image, against the decision you made, not just for crashes.

## Craft: parity, real data, alignment

Beyond the aesthetic call, these are the execution defects that reach users:

- **Preserve what exists.** Changing an app is re-style + re-structure, not rebuild from memory. Inventory the current surface first (every setting, control, injected element, piece of copy), mark each keep / merge / drop — a drop is a stated decision, never silent attrition — and re-check before handoff. A "keep" that vanished is a bug, not a detail.
- **Build for the real data range, not the happy path.** Enumerate the variance up front (null fields, 0 / 1 / many items, long strings, missing media) and hold the layout at both the sparse and the maximal extreme. The host page varies too — logged-out, narrow windows, mid-render. Every remote asset needs a fallback, every list an empty state; a console 404 is an unhandled case, not noise.
- **Alignment is correctness, not taste.** Share axes on purpose (a column's left edge; paired blocks' top/bottom), no unexplained dead space, labels on their subject's axis. Prefer CSS (grid tracks, `align-items`) over JS measurement; if you must measure, re-run on resize and after images load. Confirm by measuring bounding rects (~2px), not by eye — across states and a narrow + wide width.
- **Style every state**: hover, active/selected, focus, disabled, loading, empty, error.
- **Clarify scope once before large work.** Past a small tweak, confirm in one round — which screens, keep-vs-rebuild, how many variations. "Redesign" without "keep everything" reads as ambiguous, not "rebuild."

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

- App appears in `curl -sf "http://127.0.0.1:$port/api/apps/manifests"`. If Codex blocks localhost, retry with network access before treating this as a failure. If the endpoint is reachable but the app is missing, check `daemon.log`.
- `manifest.json` valid; `id` == directory; every referenced file exists.
- Every `airglow.rpc('foo', ...)` has a matching default export in `server/foo.ts`.
- No keys/tokens hardcoded in `userscripts/` or `ui/`.
- Tested in the real browser, not just `curl`.
- **Screenshot the rendered page** (`airglow browser shot`) and scan for layout bugs: overflow/clipping (especially the preview in the narrow rail), text spilling, a preview that doesn't match the real widget. A clean bundle with a wrong-looking page is still wrong.
