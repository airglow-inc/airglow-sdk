# Browser debugging

`airglow browser` drives the user's real Chrome (Airglow extension loaded) through the daemon — no CDP, no separate browser process, and you cannot launch one. Verify external APIs and RPCs from the terminal first; reach for the browser only when a problem can't be diagnosed there, or the user asks for browser testing.

CLI is at `~/.airglow/bin/airglow` and the installer puts it on PATH; if `command -v airglow` is empty, add it for this session: `export PATH="$HOME/.airglow/bin:$PATH"`. Editing app code reloads matching tabs automatically (no reload command).

Daemon port (for `curl`; the CLI resolves it itself):

```bash
port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' ~/.airglow/state/daemon.json)
```

Codex sandbox caveat: `curl` to `127.0.0.1` still needs network permission. Exit 7 / `CURLE_COULDNT_CONNECT` can mean the shell sandbox blocked loopback before the request reached the daemon. Retry with network access (or use `airglow browser eval --app <id> 'await airglow.rpc(...)'` for RPC checks) before diagnosing the daemon as down.

## Type-check after editing (the bundler doesn't)

The daemon transpiles without type-checking — type errors never reach the bundle or logs, only their runtime symptoms. Catch them with the workspace checker, scoped to your app:

```bash
npx tsc --noEmit 2>&1 | grep apps/<id>/   # drop the grep for the whole workspace
```

- Each file is checked as its own module (`moduleDetection: force`), so userscripts don't collide in one global scope.
- Don't write `declare const airglow: any` — it's already typed via `airglow.d.ts`, and the `any` silently disables SDK checking in that file.
- `server/` files run under Bun (`@types/bun` is a workspace dev dep).

## Logs

`airglow browser logs` merges both streams — **browser-side** (userscripts, UI, startup; last 1000 entries, uncaught errors and rejections auto-captured) and **daemon-side** (bundle errors, RPC/server-function failures, startup) — into one time-ordered view, so a browser error and the server stack that caused it sit together.

```bash
airglow browser logs                          # last 50, both streams merged
airglow browser logs --level error            # errors only (daemon lines that look like errors included)
airglow browser logs --source <app-id>        # one app's browser logs
airglow browser logs --source daemon          # just the daemon log
airglow browser logs --level error -n 10
```

The daemon log file is also readable directly (truncated each run): `tail -n 100 ~/.airglow/state/daemon.log`.

A failing userscript bundle returns a JSON error with a fix hint from its endpoint:

```bash
curl -s "http://127.0.0.1:$port/api/apps/<app-id>/userscript?file=userscripts/main.ts"
```

## RPC over curl

Hit server functions directly to isolate them from the browser flow:

```bash
curl -s -X POST "http://127.0.0.1:$port/api/apps/<app-id>/rpc/<fn>" \
  -H 'Content-Type: application/json' -d '{"key":"value"}' | jq
```

The JSON body becomes the function's `body`; the return value comes back.

If the local shell cannot use loopback networking, run the same RPC from an app-scoped browser context instead:

```bash
airglow browser eval --tab N --app <app-id> 'await airglow.rpc("<fn>", { key: "value" })'
```

## Commands

```bash
airglow browser tabs                                   # tabs grouped by window, with role: agent | agent-other | user
airglow browser open <url> [--background]             # open a tab in your own agent window
airglow browser nav --tab N <url>
airglow browser eval --tab N '<js>' [--main] [--app ID] # run JS (see Worlds)
airglow browser html --tab N [--selector '#root']      # outerHTML (whole document by default)
airglow browser shot --tab N                           # screenshot → prints saved path (captured in place, no focus change)
airglow browser close --tab N
airglow browser targets                                # connected browsers (pick with --browser <substr>)
```

Tab-targeted commands need `--tab N` (id from `tabs`). `open`ed tabs land in **your own agent window** — a dedicated, unfocused window (created on your first `open`), kept out of the user's working set. Every later `open` reuses it; you never open into a window you don't own. No approval is needed.

**Read anywhere, act only in your own window.** In `tabs`, `role: agent` is your window; `agent-other` is another agent's (off-limits); `user` is the user's. Reading any tab (`html`, `eval` to inspect, `shot`) is fine; only `open`/`nav`/`close` and state-changing `eval` (click/type/submit) in your own tabs. A tab only runs un-throttled while it's the active tab in its window — the tools activate your own tab before acting on it (so a backgrounded/discarded tab reloads), without bringing the window to the front. **Close your test tabs** (`close --tab N`) when you're done so your window doesn't pile up.

### Worlds — `eval` default vs `--main` vs `--app`

- **default**: tries a USER_SCRIPT world, then falls back through the extension debugger API on strict-CSP pages. It reads/writes the shared DOM; the USER_SCRIPT path has its own `window`, while the debugger fallback sees the page's main context.
- **`--main`**: the page's MAIN world — page globals **are** visible; if the page CSP blocks the wrapper, eval falls back through the same debugger path.
- **`--app ID`**: app ID's own userscript world, with its **`airglow` SDK in scope** — `airglow.storage`, `rpc`, `llm`, `connectors` all run scoped to that app. This is how you exercise the SDK exactly as the app sees it (the plain worlds above have no `airglow`); there is no separate storage command.

`eval` is **async** — `await` works, and a bare expression returns its value. Read an app's stored setting straight through the SDK:

```bash
airglow browser eval --tab N --app <app-id> 'await airglow.storage.get("autoplay")'
airglow browser eval --tab N --app <app-id> 'await airglow.storage.list()'
airglow browser eval --tab N --app <app-id> 'await airglow.rpc("fetch-sheet", { id })'
```

`--app` needs a regular (http/https) tab to inject into; open one in your own agent window first. Multiple statements per call are fine: `eval 'a().click(); b().click()'` (use `return` to get a value back from a statement block).

### Frames & app UIs

`html`/`eval` default to the top frame; `--frame <url-substr>` targets a child frame. **Extension pages** (`chrome-extension://`, the dashboard) are driven via the debugger API — same commands, and the top frame sees page globals without `--main` (Chrome shows an "Airglow started debugging" infobar, expected). The dashboard's `chrome-extension://…/dashboard.html` URL is in your Environment context; `airglow browser open` accepts it.

**Test an app UI with `airglow browser open --app <id>`.** It opens the app's UI (`…/api/apps/<id>/ui?app=<id>`) as a top-level tab; the `app-ui-bridge` content script wires `airglow.*` on it (RPCs/storage live, render-gates resolve), so `eval`/`html`/`shot` read it directly — no `--frame`, no cross-origin iframe. The wiring comes from the extension being loaded in that browser, not from the URL: `curl`-ing the same URL — or opening it without `?app=<id>`, or in a browser without the extension — is unwired, so `airglow.*` never resolves and render-gated UIs hang at their loading state. Don't test via the dashboard `chrome-extension://` page either (its app iframe is cross-origin, so `eval --frame` can't reach it — only `shot` works there).

Fidelity caveat: this is the same bundle/SDK/data the user gets, but a **top-level dev view**, not the exact embedding. The dashboard runs the app in a sandboxed iframe sized by its layout, so viewport-relative layouts (`vh`/`h-screen`) and sandbox-blocked behaviour (raw `window.open`, `alert`) can differ — spot-check those in the real dashboard with `shot`.

- **Bare bundle via `curl`** — `curl "http://127.0.0.1:$port/api/apps/<app-id>/ui?app=<app-id>"` returns the UI's HTML *outside* the extension, so no content-script bridge runs and `airglow.*` (storage, rpc, …) never resolves. A UI that gates render on the SDK — e.g. `if (!ready) return null` where `ready` flips only after an `rpc`/`storage` call — paints an **empty `#root` with no error**: a false negative that reads as a bug but is your test harness, not the app. (Opening the same URL as a browser tab via `open --app` *is* wired — the difference is the extension, not the URL.) Use the curl'd bundle **only** for SDK-free React render/hook checks; never to confirm an app works or to read app state.

The page `--app` opens is a normal top-level tab, so everything works without workarounds — `airglow.*` is live, render-gates resolve, and `window.__test` / `button.click()` / page globals are reachable via `--main`:

```bash
airglow browser open --app <app-id>                  # fully wired, top-level
airglow browser eval --tab N --main 'window.__test.run()'
airglow browser shot --tab N                         # read it as the user would see it
```

Driving React: `button.click()` works (root delegation); `input.value = 'x'` does **not** update React state — expose a `window.__test` object in the component and call it with `--main` (see `AGENTS.md`).

## Network capture (reverse-engineering a site's API)

```bash
airglow browser attach --tab N                     # start capture
airglow browser read [--url S] [--method POST]     # captured requests (compact); --clear to flush
airglow browser entry --i N                        # full request/response for one entry
airglow browser detach --tab N                     # stop capture
```
