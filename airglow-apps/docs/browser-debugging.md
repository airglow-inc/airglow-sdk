# Browser debugging

Browser debugging is the last stage of testing — only get here after verifying external APIs directly. Then:

1. Reload the affected page after editing app code.
2. Read logs to see what happened.
3. Drive the browser with `pnpm dom` (read/modify DOM, eval, screenshot, tabs).

The user's Chrome (with the Airglow extension loaded) is what `pnpm dom` drives — through
the trace host. No CDP needed.

## Ports

| Port | Default for | Notes |
|---|---|---|
| `3222` | the **dev server** (`pnpm airglow dev`) — manifests, RPC, bundles | change with `--port N`, then set the matching port in the extension dashboard |
| `3277` | the **trace host** — the extension's debug bridge (logs, reload, network capture) | if busy, the host auto-falls-back to a random port |

Live port mappings (one JSON record per trace host) live at `~/.airglow/hosts/`. With
multiple Chromes running, look at a record's `userDataDir` to see which browser it
belongs to.

## Reloading after code changes

After editing app source, reload the affected page with `pnpm dom reload --tab N`.
The dev server reloads matching tabs automatically when userscripts change.

## Reading logs

Two log streams, depending on where things break:

**Browser-side** (userscripts, UI, startup, extension) — kept in `chrome.storage.local`, last 1000 entries. SDK auto-captures uncaught errors and unhandled rejections; apps also write via `airglow.log.info/warn/error`.

```bash
curl -s localhost:3277/logs | jq                            # last 50
curl -s 'localhost:3277/logs?level=error' | jq              # errors only
curl -s 'localhost:3277/logs?source=<app-id>' | jq          # per-app
curl -s 'localhost:3277/logs?level=error&n=10' | jq         # last 10 errors
```

**Dev-server-side** (bundle errors, RPC failures, startup) — mirrored to `.airglow/dev.log` in the workspace, truncated each run.

```bash
tail -n 100 .airglow/dev.log                                # last 100 lines
```

## Hitting server endpoints with curl

Server functions are exposed by the dev server as RPC endpoints. Hit them directly to isolate problems from the browser-side flow:

```bash
curl -s -X POST http://127.0.0.1:3222/api/apps/<app-id>/rpc/<function-name> \
  -H 'Content-Type: application/json' \
  -d '{"key":"value"}' | jq
```

The JSON body becomes the function's `body` argument; the return value is what comes back.

## Driving the browser (`pnpm dom`)

`pnpm dom` reads/edits the DOM and controls tabs through the trace host. The port
auto-resolves from `~/.airglow/hosts/`; pass `--port N` to pick a specific browser
(see [Ports](#ports)).

```bash
pnpm dom port                                     # resolved trace-host port
pnpm dom tabs                                      # list open tabs (id, url)
pnpm dom frames --tab 12                           # list a tab's frames (frameId, url)
pnpm dom html   --tab 12 [--selector '#root']      # outerHTML (whole document by default)
pnpm dom eval   --tab 12 'document.title'          # run JS (see Worlds below)
pnpm dom set    --tab 12 --selector '#s' 'done'    # set innerHTML (--outer for outerHTML)
pnpm dom shot   --tab 12 [--out f.jpg]             # screenshot — JPEG q90 (brings the tab's window to front)
pnpm dom open   https://example.com [--background]  # open a tab (in the debug window)
pnpm dom nav    --tab 12 https://example.com        # navigate a tab
pnpm dom reload --tab 12                            # reload a tab
pnpm dom close  --tab 12                            # close a tab
```

Every tab-targeted command requires `--tab N`. Get the id from `pnpm dom tabs`. `open`ed
tabs land in a dedicated, unfocused **debug window** so the agent's tabs stay out of the
user's working set (reused across `open`s, recreated if closed).

### Worlds — `eval` default vs `--main`

`eval` runs in a CSP-exempt USER_SCRIPT world by default: arbitrary JS works even on
strict-CSP sites (GitHub, Gmail), reading/writing the shared DOM — but it has its own
`window`, so **page globals are not visible** (`window.__test`, framework objects, the
page's own variables). Add `--main` to run in the page's **MAIN** world: page globals
ARE visible, but the page's CSP applies (eval can be blocked on hardened sites).
Multiple statements per call are fine: `eval 'a().click(); b().click()'`.

### Frames & app UIs

`html`/`eval`/`set` default to a tab's top frame; `--frame <url-substr>` targets a
child frame (use `frames` to list them). **Exception — app UIs:** they render in an
iframe inside `app-shell.html`, which is a `chrome-extension://` page, and extensions
**cannot script their own pages** (no host permission covers that scheme), so `--frame`
can't reach the iframe. Instead, **open the app UI directly** as a top-level tab:

```bash
pnpm dom open "http://127.0.0.1:3222/api/apps/<app-id>/ui?app=<app-id>"
pnpm dom eval --tab N --main 'window.__test.run()'   # drive React via its test hook
```

Driving React: `button.click()` works (root delegation); `input.value = 'x'` does NOT
update React state — expose a `window.__test` object in the component and call it with
`--main` (see `CLAUDE.md`).

## Last resort: CDP via `pnpm chrome`

If `pnpm dom` genuinely can't cover what you need (e.g. scripting an extension page,
a CDP method `dom` doesn't expose), `pnpm chrome` launches a dedicated Chrome with the
extension pre-loaded and CDP on `:9222`. **Ask the user before using this** — it's a
separate browser instance and they may not want a second Chrome window opening on them.
