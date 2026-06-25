# Airglow host

One Bun-compiled binary, four modes (dispatched on argv):

- **Connector** — spawned by Chrome via native messaging (host name `com.airglow.host`). Finds-or-spawns the daemon, then bridges extension ⇄ daemon. One per running Chrome; all share the single daemon, so multiple Chrome processes share the same apps.
- **Daemon** (`airglow daemon`) — the per-machine singleton that owns the workspace (`~/.airglow`). Serves the local app API the extension loads from (manifests, bundled userscripts/UI, settings, RPC), routes browser-bridge commands, and runs agent sessions. Bundling and server functions run on the embedded Bun — no node/esbuild/pnpm on the machine.
- **Browser CLI** (`airglow browser <cmd>`) — drives the user's Chrome through daemon → connector → extension: `tabs, open, nav, eval, html, shot, close, logs, targets` + network capture (`attach, detach, read, entry`). No tab reload (the extension auto-reloads on source change), no browser spawning.
- **Toolkit CLI** (`airglow toolkit <cmd>`) — Composio-backed third-party tools: discover toolkits/tools/schemas, connect via OAuth, execute. Same path backs `airglow.connectors`; connections are scoped per app (CLI default scope: the agent). Prod forwards to the cloud connector gateway with the user's session token (sign-in required; the shared Composio key lives only in airglow-cloud). Dev escape hatch: `COMPOSIO_API_KEY` in the workspace `.env` switches to direct Composio mode, no sign-in.

## Install (end users)

```bash
curl -fsSL https://airglow.dev/install.sh | bash
```

Downloads the platform binary from the latest `host-v*` GitHub release into `~/.airglow/bin/airglow` and runs `airglow install`, which registers the native messaging host for every Chromium variant and seeds the workspace:

- `apps/` — user space, never touched
- `shared/`, `docs/`, `AGENTS.md`, `airglow.d.ts` — vendored, force-overwritten on update
- `package.json`, `tsconfig.json` — created once, then left alone

Baseline deps install with the binary's embedded bun (`BUN_BE_BUN=1`); no node/bun/pnpm required. Seed sources are `host/seed/**` plus theme fonts from `extension/public/fonts/`, packed into the binary by `scripts/pack-seed.ts` at build time (source runs read the repo directly).

## Development

```bash
bun install
bun run src/main.ts daemon          # daemon against ~/.airglow
bun run src/main.ts install         # register the NM host (launcher runs this source) + seed ~/.airglow
bun run src/main.ts browser tabs    # CLI against the running daemon
bun run build                       # → dist/airglow (single binary, current platform)
bun run build:release               # → dist/airglow-{darwin-arm64,darwin-x64,linux-x64} + SHA256SUMS
```

After `install`, fully restart Chrome so it picks up the native messaging manifest; the connector then auto-spawns the daemon. A daemon you started manually with `--workspace` wins — connectors attach to it instead.

**Releasing:** bump `package.json`, `bun run build:release`, then publish the three binaries on a `host-vX.Y.Z` GitHub release. `install.sh` picks the newest release carrying the platform asset, so extension (`vX.Y.Z`) and host releases can interleave.

## State

`~/.airglow/state/`: `daemon.json` (listen address), `daemon.lock`, `daemon.log` (truncated each run), `shots/` (screenshots), `sessions/` (sidepanel agent conversations — terminal agents keep their own history). The extension stores the daemon origin from the connector handshake (`__daemon_origin`) and uses it as the app source, so the port never needs configuring — `3222` preferred, random free port as fallback.
