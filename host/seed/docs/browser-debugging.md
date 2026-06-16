# Browser debugging

Browser debugging is the last stage of testing — only get here after verifying external APIs directly. Then:

1. Edit app code; the platform reloads matching tabs automatically (there is no reload command).
2. Read logs to see what happened.
3. Drive the browser with `airglow browser` (read DOM, eval, screenshot, tabs).

`airglow browser` drives the user's real Chrome (with the Airglow extension loaded) through the daemon. No CDP, no separate browser process — and you cannot launch one.

The CLI lives at `~/.airglow/bin/airglow`; put it on PATH once per session: `export PATH="$HOME/.airglow/bin:$PATH"`.

## The daemon port

The daemon serves manifests, bundles, and RPC on the port recorded in `~/.airglow/state/daemon.json` (default `3222`):

```bash
port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' ~/.airglow/state/daemon.json)
```

`airglow browser` resolves the port itself — you only need it for `curl`.

## Reading logs

Two log streams, depending on where things break:

**Browser-side** (userscripts, UI, startup, extension) — last 1000 entries. The SDK auto-captures uncaught errors and unhandled rejections; apps also write via `airglow.log.info/warn/error`.

```bash
airglow browser logs                          # last 50
airglow browser logs --level error            # errors only
airglow browser logs --source <app-id>        # per-app
airglow browser logs --level error -n 10      # last 10 errors
```

**Daemon-side** (bundle errors, RPC failures, startup) — `~/.airglow/state/daemon.log` in the workspace, truncated each daemon run.

```bash
tail -n 100 ~/.airglow/state/daemon.log
```

A failing userscript bundle is also diagnosable directly — the endpoint returns a JSON error with a fix hint:

```bash
curl -s "http://127.0.0.1:$port/api/apps/<app-id>/userscript?file=userscripts/main.ts"
```

## Hitting server endpoints with curl

Server functions are exposed by the daemon as RPC endpoints. Hit them directly to isolate problems from the browser-side flow:

```bash
curl -s -X POST "http://127.0.0.1:$port/api/apps/<app-id>/rpc/<function-name>" \
  -H 'Content-Type: application/json' \
  -d '{"key":"value"}' | jq
```

The JSON body becomes the function's `body` argument; the return value is what comes back.

## Driving the browser (`airglow browser`)

```bash
airglow browser tabs                                   # list open tabs (id, url, title)
airglow browser open <url> [--background]              # open a tab (in the agent debug window)
airglow browser nav --tab N <url>                      # navigate a tab
airglow browser eval --tab N '<js>' [--main]           # run JS (see Worlds below)
airglow browser html --tab N [--selector '#root']      # outerHTML (whole document by default)
airglow browser shot --tab N                           # screenshot — prints the saved file path (brings the tab's window to front)
airglow browser close --tab N                          # close a tab
airglow browser targets                                # connected browsers (multi-Chrome setups; pick one with --browser <substr>)
```

Every tab-targeted command requires `--tab N`. Get the id from `airglow browser tabs`. `open`ed tabs land in a dedicated, unfocused **debug window** so the agent's tabs stay out of the user's working set (reused across `open`s, recreated if closed). The first `open` in a session may require the user's approval.

### Worlds — `eval` default vs `--main`

`eval` runs in a CSP-exempt USER_SCRIPT world by default: arbitrary JS works even on strict-CSP sites (GitHub, Gmail), reading/writing the shared DOM — but it has its own `window`, so **page globals are not visible** (`window.__test`, framework objects, the page's own variables). Add `--main` to run in the page's **MAIN** world: page globals ARE visible, but the page's CSP applies (eval can be blocked on hardened sites). Multiple statements per call are fine: `eval 'a().click(); b().click()'`.

### Frames & app UIs

`html`/`eval` default to a tab's top frame; `--frame <url-substr>` targets a child frame. **Extension pages** (`chrome-extension://` — the dashboard) are driven through the debugger API instead of the normal scripting path (host permissions can't match that scheme); commands work the same, and the top frame's `eval` sees page globals directly (no `--main` needed). Chrome shows its "Airglow started debugging this browser" infobar while a `chrome-extension://` tab is being driven — expected, and confined to these agent tabs.

For the **app UI iframe** embedded in the dashboard, `--frame` reaches it for DOM reads/clicks, but its MAIN world (the app's own globals, e.g. `window.__test`) is not visible there. To drive the app's React hooks, **open the app UI directly** as a top-level tab:

```bash
airglow browser open "http://127.0.0.1:$port/api/apps/<app-id>/ui?app=<app-id>"
airglow browser eval --tab N --main 'window.__test.run()'   # drive React via its test hook
```

Driving React: `button.click()` works (root delegation); `input.value = 'x'` does NOT update React state — expose a `window.__test` object in the component and call it with `--main` (see `AGENTS.md`).

## Network capture (reverse-engineering a site's API)

Capture fetch/XHR traffic on a tab to discover the requests a site makes:

```bash
airglow browser attach --tab N                     # start capture on a tab
airglow browser read [--url S] [--method POST]     # captured requests (compact); --clear to flush
airglow browser entry --i N                        # full request/response for one entry
airglow browser detach --tab N                     # stop capture
```
