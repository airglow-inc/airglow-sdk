# Airglow CLI

CLI to run local Airglow apps.

Run it from `../airglow-apps/`:

```
$ pnpm airglow --help

  ◆ airglow — build apps for the web

Commands:
  new <app-id>                   Scaffold a new app (app-id: lowercase a-z, digits, dashes)
  dev [--port N] [--apps-dir D]  Run apps locally with hot reload

Run from inside the workspace (cd airglow-apps).

Options:
  --port N           Bind port (default 3001)
  --apps-dir D       Apps workspace directory (default cwd)
  --help, -h         Show this message
```

## Auto-update

`airglow dev` checks the SDK git checkout before loading the TypeScript CLI. It only auto-updates the `main` branch, first compares the local HEAD with the remote branch SHA, then applies a fast-forward update if needed. It skips the update when the checkout is detached, on another branch, has no upstream, has local tracked changes, or has local commits.

Untracked app folders do not block updates. If package inputs changed, Airglow runs `pnpm install --frozen-lockfile` in `airglow-apps`. If extension files changed, Airglow best-effort reloads the running Chrome extension after verifying that `localhost:3101` is the Airglow native host.

Set `AIRGLOW_AUTO_UPDATE=0` to disable updates for one process, or set `autoUpdate: false` in the active apps workspace `.airglow/config.json` to persist the preference. Set `AIRGLOW_AUTO_INSTALL=0` to skip dependency installation after an update. Set `AIRGLOW_AUTO_RELOAD_EXTENSION=0` to skip extension reload.

## Layout

```
cli/
├── bin/airglow.js          # CLI entrypoint (loads tsx, then src/cli.ts)
├── src/
│   ├── cli.ts              # arg dispatcher
│   ├── new.ts              # `airglow new` command
│   └── dev.ts              # `airglow dev` command (HTTP server, bundler, RPC runner)
└── lib/
    ├── airglow-sdk.ts      # SDK source
    └── native-host/        # Chrome native-messaging host (extension debug bridge)
```

## Endpoints

### Dev server (default `:3001`)

| Endpoint | Purpose |
|---|---|
| `GET /api/healthz` | Liveness probe. |
| `GET /api/apps/manifests` | List all app manifests. |
| `GET /api/apps/<id>/userscript?file=...&format=iife\|esm` | Bundled userscript JS. |
| `GET /api/apps/<id>/ui` | React panel HTML (full SDK inlined). |
| `GET /api/apps/<id>/ui-bundle` | React panel JS bundle (no HTML wrapper). |
| `GET /api/apps/<id>/settings` | `CLIENT_*` env values from `.env`, used as dev-fallback secrets when the user hasn't set them in the dashboard. |
| `POST /api/apps/<id>/rpc/<fn>` | Invoke `server/<fn>.ts` default export with the JSON body as payload. |
| `GET /api/config` / `POST /api/config` | Read/write local Airglow preferences such as `autoUpdate`. |

### Native-host debug bridge (default `:3101`)

Extension log tail, reload trigger, and network-spy for reverse-engineering site APIs. See [`lib/native-host/README.md`](lib/native-host/README.md) for the full endpoint list.
