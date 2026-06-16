# Airglow host

One Bun-compiled binary, three modes:

- **Connector** (spawned by Chrome via native messaging, host name `com.airglow.host`) — finds-or-spawns the daemon, then bridges extension ⇄ daemon. One per running Chrome; all of them share the single daemon, so multiple Chrome processes share the same apps.
- **Daemon** (`airglow daemon`) — the singleton per-machine process that owns the workspace (`~/.airglow` by default). Serves the local app API the extension loads apps from (manifests, bundled userscripts/UI, settings, RPC — same HTTP contract as the old `airglow dev` server), routes browser-bridge commands, and (next phase) runs agent sessions. Bundling and server-function execution use Bun itself — no node/esbuild/pnpm required on the machine.
- **Browser CLI** (`airglow browser <cmd>`) — drives the user's running Chrome through daemon → connector → extension. Command surface: `tabs, open, nav, eval, html, shot, close, logs, targets` plus network capture (`attach, detach, read, entry`). No tab reload (the extension auto-reloads tabs when app source changes), no set-html (use `eval`), no browser spawning.
- **Toolkit CLI** (`airglow toolkit <cmd>`) — third-party tool access (Composio-backed): discover toolkits/tools/schemas, connect via OAuth, execute. Same path backs `airglow.connectors` in the SDK; connections are scoped per app (CLI default scope: the agent). Production: the daemon forwards to the cloud connector gateway with the user's session token (sign-in required; the shared Composio project key lives only in airglow-cloud). Dev escape hatch: `COMPOSIO_API_KEY` in the workspace `.env` switches the daemon to direct Composio mode (`src/daemon/connectors.ts`), no sign-in needed.

## Installation (end users)

```bash
curl -fsSL https://airglow.dev/install.sh | bash
```

Downloads the platform binary from the latest `host-v*` GitHub release into `~/.airglow/bin/airglow` and runs `airglow install`, which registers the native messaging host for every installed Chromium variant and **seeds the workspace**: `apps/` (user space, never touched), managed `shared/` + `docs/` + `AGENTS.md` + `airglow.d.ts` (force-overwritten on update — vendored), `package.json` + `tsconfig.json` (created once, then left alone), then installs baseline deps with the binary's own embedded bun (`BUN_BE_BUN=1`). No node/bun/pnpm required on the machine.

Seed sources: `host/seed/**` — the entire canonical seed surface (`shared/`, `airglow.d.ts`, `docs/`, `AGENTS.md`, `CLAUDE.md`, `package.json`, `tsconfig.json`) plus the theme fonts from `extension/public/fonts/` — packed into the binary by `scripts/pack-seed.ts` at build time. Source runs read the repo directly.

## Development

```bash
bun install
bun run src/main.ts daemon                                # daemon against ~/.airglow (default workspace)
bun run src/main.ts install                               # register the NM host (writes a launcher that runs this source) + seed ~/.airglow
bun run src/main.ts browser tabs                          # CLI against the running daemon
bun run build                                             # compile dist/airglow (single binary, current platform)
bun run build:release                                     # dist/airglow-{darwin-arm64,darwin-x64,linux-x64} + SHA256SUMS
```

Releasing: run `bun run build:release`, then publish the three binaries on a `host-vX.Y.Z` GitHub release (bump `package.json` version first). `install.sh` picks the newest release that carries the platform asset, so extension (`vX.Y.Z`) and host releases can interleave.

After `install`, fully restart Chrome so it picks up the native messaging manifest. The connector then auto-spawns the daemon (default workspace `~/.airglow`); a daemon started manually with `--workspace` beforehand wins — connectors attach to it instead.

State lives in `~/.airglow/state/`: `daemon.json` (where the daemon listens), `daemon.lock`, `daemon.log` (truncated each run), `shots/` (screenshots), `sessions/` (agent sessions, next phase).

The extension stores the daemon origin from the connector handshake (`__daemon_origin`) and uses it as the local app source, so the daemon's port never needs configuring — port 3222 is preferred, with automatic fallback to a random free port.
