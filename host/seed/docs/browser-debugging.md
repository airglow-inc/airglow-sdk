# Browser debugging

`airglow browser` drives the user's real Chrome (Airglow extension loaded) through the daemon — no CDP, no separate browser process, and you cannot launch one. It is the last testing stage: verify external APIs directly first, then debug in the browser.

CLI is at `~/.airglow/bin/airglow`; put it on PATH once per session: `export PATH="$HOME/.airglow/bin:$PATH"`. Editing app code reloads matching tabs automatically (no reload command).

Daemon port (for `curl`; the CLI resolves it itself):

```bash
port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' ~/.airglow/state/daemon.json)
```

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

## Commands

```bash
airglow browser tabs                                   # list open tabs (id, url, title)
airglow browser open <url> [--background]              # open a tab in the agent debug window
airglow browser nav --tab N <url>
airglow browser eval --tab N '<js>' [--main] [--app ID] # run JS (see Worlds)
airglow browser html --tab N [--selector '#root']      # outerHTML (whole document by default)
airglow browser shot --tab N                           # screenshot → prints saved path (brings window to front)
airglow browser close --tab N
airglow browser targets                                # connected browsers (pick with --browser <substr>)
```

Tab-targeted commands need `--tab N` (id from `tabs`). `open`ed tabs land in a dedicated, unfocused **debug window** so they stay out of the user's working set; the first `open` may require approval.

### Worlds — `eval` default vs `--main` vs `--app`

- **default**: CSP-exempt USER_SCRIPT world — works on strict-CSP sites, reads/writes the shared DOM, but has its own `window`, so **page globals are not visible** (`window.__test`, framework objects).
- **`--main`**: the page's MAIN world — page globals **are** visible, but the page's CSP applies (eval can be blocked on hardened sites).
- **`--app ID`**: app ID's own userscript world, with its **`airglow` SDK in scope** — `airglow.storage`, `rpc`, `llm`, `connectors` all run scoped to that app. This is how you exercise the SDK exactly as the app sees it (the plain worlds above have no `airglow`); there is no separate storage command.

`eval` is **async** — `await` works, and a bare expression returns its value. Read an app's stored setting straight through the SDK:

```bash
airglow browser eval --tab N --app <app-id> 'await airglow.storage.get("autoplay")'
airglow browser eval --tab N --app <app-id> 'await airglow.storage.list()'
airglow browser eval --tab N --app <app-id> 'await airglow.rpc("fetch-sheet", { id })'
```

`--app` needs a regular (http/https) tab to inject into; open one in your debug window first. Multiple statements per call are fine: `eval 'a().click(); b().click()'` (use `return` to get a value back from a statement block).

### Frames & app UIs

`html`/`eval` default to the top frame; `--frame <url-substr>` targets a child frame. **Extension pages** (`chrome-extension://`, the dashboard) are driven via the debugger API — same commands, and the top frame sees page globals without `--main` (Chrome shows an "Airglow started debugging" infobar, expected). The dashboard's `chrome-extension://…/dashboard.html` URL is in your Environment context; `airglow browser open` accepts it.

Two ways to reach an app's UI, and they are **not** equivalent:

- **Real app** — open the dashboard (`chrome-extension://…/dashboard.html`) and navigate to the app. Here the UI runs fully wired: `airglow.*` resolves, `chrome.storage` is live. Reach the app iframe with `--frame`.
- **Bare bundle** — `http://127.0.0.1:$port/api/apps/<app-id>/ui?app=<app-id>` is the UI served standalone, outside the extension: good for driving React render/hooks, but `airglow.*` calls (storage, rpc, …) have no extension to talk to and won't resolve. Don't read app state here.

The app UI iframe is reachable via `--frame` for DOM reads/clicks, but its MAIN world (the app's `window.__test`) is not. To drive the app's React hooks, open the bare bundle as a top-level tab:

```bash
airglow browser open "http://127.0.0.1:$port/api/apps/<app-id>/ui?app=<app-id>"
airglow browser eval --tab N --main 'window.__test.run()'
```

Driving React: `button.click()` works (root delegation); `input.value = 'x'` does **not** update React state — expose a `window.__test` object in the component and call it with `--main` (see `AGENTS.md`).

## Network capture (reverse-engineering a site's API)

```bash
airglow browser attach --tab N                     # start capture
airglow browser read [--url S] [--method POST]     # captured requests (compact); --clear to flush
airglow browser entry --i N                        # full request/response for one entry
airglow browser detach --tab N                     # stop capture
```
