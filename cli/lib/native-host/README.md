# Airglow extension debug bridge

Chrome native-messaging host exposing the running extension over `localhost:3101`.

## Endpoints

### Primary (always available)

| Endpoint | Purpose |
|---|---|
| `GET /status` | Liveness probe. Returns `{ok, buffered}`. |
| `GET /logs` | Extension log store. Filters: `level=info\|warn\|error`, `source=<app-id>`, `n=<count>`. `source` is `manifest.id`. |
| `POST /reload` | `chrome.runtime.reload()`. |

### Network-spy (dormant unless attached)

For reverse-engineering a website's API. Zero overhead until `/attach`.

| Endpoint | Purpose |
|---|---|
| `POST /attach` | Start capturing on a tab. Body: `{tabId, url}`. |
| `POST /detach` | Stop capturing on a tab. Body: `{tabId}`. |
| `GET /read` | List captured requests. Filters: `url=`, `method=`, `noise=1`, `ignore=a,b`, `since=<ts>`, `clear=1`, `compact=1`. |
| `GET /entry?i=N` | Full request/response. Params: `curl=1`, `body=req\|res\|both`. |
| `GET /storage` | Read `localStorage`/`sessionStorage` from the attached page. Params: `pattern=<regex>`, `store=local\|session\|both`, `full=1`. |

Loop: `/attach` → action in browser → `/read?compact=1` → `/entry?i=N&curl=1` → replay with `curl`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `AIRGLOW_SPY_PORT` | `3101` | HTTP server port. |
