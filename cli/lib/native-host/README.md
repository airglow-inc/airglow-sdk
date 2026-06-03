# Airglow extension debug bridge

Chrome native-messaging host exposing the running extension over `localhost:3277`.

## Endpoints

### Extension control

| Endpoint | Purpose |
|---|---|
| `GET /status` | Liveness probe. Returns `{ok, service: 'airglow-trace', buffered}`. |
| `GET /logs` | Extension log store. Filters: `level=info\|warn\|error`, `source=<app-id>`, `n=<count>`. |
| `POST /reload` | `chrome.runtime.reload()`. |

### Browser interaction

| Endpoint | Purpose |
|---|---|
| `GET /tabs` | List open tabs: `{tabs:[{id, url, title, active, windowId}]}`. |
| `GET /frames` | List a tab's frames (`frameId`, `url`) for `frame` targeting. Params: `tabId`. |
| `POST /open` | Open a new tab in the dedicated debug window. Body: `{url, active?}`. |
| `POST /navigate` | Point a tab at a URL. Body: `{tabId, url}`. |
| `POST /reloadtab` | Reload a tab. Body: `{tabId}`. |
| `POST /close` | Close a tab. Body: `{tabId}`. |
| `GET /html` | `outerHTML` via `chrome.scripting`. Params: `tabId` (required), `selector` (default: whole document), `frame` (URL substring → child frame). |
| `POST /eval` | Run JS. Default: CSP-exempt USER_SCRIPT world (works on strict-CSP pages, but no page globals). Body: `{tabId, code, frame?, main?}`; `main:true` runs in the page MAIN world (sees page globals, page CSP applies). Returns `{value}`. |
| `POST /sethtml` | Set inner/`outer`HTML. Body: `{tabId, selector, html, outer?, frame?}`. |
| `POST /capture` | Screenshot the tab (activates it first). Body: `{tabId}`. Returns `{dataUrl}` (JPEG, q90). |

### Network-trace (dormant unless attached)

For reverse-engineering a website's API. Zero overhead until `/attach`.

| Endpoint | Purpose |
|---|---|
| `POST /attach` | Start capturing on a tab. Body: `{tabId, url}`. |
| `POST /detach` | Stop capturing on a tab. Body: `{tabId}`. |
| `GET /read` | List captured requests. Filters: `url=`, `method=`, `noise=1`, `ignore=a,b`, `since=<ts>`, `clear=1`, `compact=1`. |
| `GET /entry?i=N` | Full request/response. Params: `curl=1`, `body=req\|res\|both`. |
| `GET /storage` | Read `localStorage`/`sessionStorage` from the attached page. Params: `pattern=<regex>`, `store=local\|session\|both`, `full=1`. |

Loop: `/attach` → action in browser → `/read?compact=1` → `/entry?i=N&curl=1` → replay with `curl`.

## Port

Defaults to `3277`; if that's busy (e.g. a second Airglow browser already took it)
the host binds a random free port and publishes a record at `~/.airglow/hosts/<pid>.json`
so callers can discover the actual port. Records are removed on exit; stale ones
(dead pid) are pruned by any reader.
