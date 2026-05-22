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
  --port N           Bind port (default 3001, or AIRGLOW_DEV_SERVER_PORT env)
  --apps-dir D       Apps workspace directory (default cwd)
  --help, -h         Show this message
```

## Layout

```
cli/
├── bin/airglow.js     # CLI entrypoint (loads tsx, then src/cli.ts)
├── src/
│   ├── cli.ts         # arg dispatcher
│   ├── new.ts         # `airglow new` command
│   └── dev.ts         # `airglow dev` command (HTTP server, bundler, RPC runner)
└── lib/
    └── airglow-sdk.ts # SDK source
```

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/healthz` | Liveness probe. |
| `GET /api/apps/manifests` | List all app manifests. |
| `GET /api/apps/<id>/userscript?file=...&format=iife\|esm` | Bundled userscript JS. |
| `GET /api/apps/<id>/ui` | React panel HTML (full SDK inlined). |
| `GET /api/apps/<id>/ui-bundle` | React panel JS bundle (no HTML wrapper). |
| `GET /api/apps/<id>/settings` | `CLIENT_*` env values from `.env`, used as dev-fallback secrets when the user hasn't set them in the dashboard. |
| `POST /api/apps/<id>/rpc/<fn>` | Invoke `server/<fn>.ts` default export with the JSON body as payload. |
