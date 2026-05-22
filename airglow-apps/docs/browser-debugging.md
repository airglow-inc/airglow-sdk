# Browser debugging

Browser debugging is the last stage of testing — only get here after verifying external APIs directly. Then:

1. Launch Chrome yourself.
2. Reload the affected page after editing app code.
3. Read logs to see what happened.
4. Drive the browser via CDP to verify behavior interactively.

## Starting the dev browser

```bash
pnpm chrome
```

Launches Chrome with the Airglow extension pre-loaded, an isolated profile, and CDP exposed on `:9222`. The extension also exposes `localhost:3101` via a native messaging host (installed on `pnpm airglow dev` startup), available as soon as the extension connects.

The user does not normally start the dev browser — the agent does.

## Reloading after code changes

After editing app source in this workspace, reload the affected page (`Page.reload` via CDP). The dev server reloads matching tabs automatically when userscripts change, and the page reload picks up everything else.

## Reading logs

Two log streams, depending on where things break:

**Browser-side** (userscripts, UI, startup, extension) — kept in `chrome.storage.local`, last 1000 entries. SDK auto-captures uncaught errors and unhandled rejections; apps also write via `airglow.log.info/warn/error`.

```bash
curl -s localhost:3101/logs | jq                            # last 50
curl -s 'localhost:3101/logs?level=error' | jq              # errors only
curl -s 'localhost:3101/logs?source=<app-id>' | jq          # per-app
curl -s 'localhost:3101/logs?level=error&n=10' | jq         # last 10 errors
```

Or open the dashboard UI: `chrome-extension://<EXTENSION_ID>/dashboard.html?page=logs`.

**Dev-server-side** (bundle errors, RPC failures, startup) — mirrored to `.airglow/dev.log` in the workspace, truncated each run.

```bash
tail -n 100 .airglow/dev.log                                # last 100 lines
```

## Hitting server endpoints with curl

Server functions are exposed by the dev server as RPC endpoints. Hit them directly to isolate problems from the browser-side flow:

```bash
curl -s -X POST http://127.0.0.1:3001/api/apps/<app-id>/rpc/<function-name> \
  -H 'Content-Type: application/json' \
  -d '{"key":"value"}' | jq
```

The JSON body becomes the function's `body` argument; the return value is what comes back.

## Driving the browser via CDP

List open tabs and grab their WebSocket URLs:

```bash
curl -s http://localhost:9222/json | node -e "
  JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))
    .forEach(t => console.log(t.url, '\n  ws:', t.webSocketDebuggerUrl))"
```

Connect to a tab and drive it (navigate, run JS, screenshot):

```bash
node -e "
const ws = new WebSocket('ws://localhost:9222/devtools/page/<ID>');
let id = 1;
const send = (method, params={}) => new Promise(resolve => {
  const i = id++; ws.send(JSON.stringify({id:i,method,params}));
  ws.addEventListener('message', function h(evt) {
    const m=JSON.parse(evt.data); if(m.id===i){ws.removeEventListener('message',h);resolve(m.result)}
  });
});
ws.addEventListener('open', async () => {
  await send('Page.navigate', {url:'https://example.com'});
  await new Promise(r=>setTimeout(r,1500));
  const r = await send('Runtime.evaluate', {expression:'document.title'});
  console.log(r.result.value);
  const ss = await send('Page.captureScreenshot', {format:'png'});
  require('fs').writeFileSync('/tmp/ss.png', Buffer.from(ss.data,'base64'));
  ws.close();
});"
```

Key methods: `Page.navigate`, `Page.reload`, `Page.captureScreenshot`, `Runtime.evaluate`.

## Testing React UIs

App UIs run inside a sandboxed iframe inside `app-shell.html`. To interact, connect to the **iframe's** WebSocket target (its URL contains `127.0.0.1:3001`), not the outer `app-shell` page.

What works:

- `button.click()` — React picks it up via root delegation
- DOM reads, screenshots
- `airglow.rpc(...)` via `Runtime.evaluate`

What doesn't:

- `select.value = 'x'` / `input.value = 'x'` — React tracks state internally and ignores native value changes. Drive these via a `window.__test` object exposed by the component (see `CLAUDE.md`).
