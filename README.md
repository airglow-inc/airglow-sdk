# Airglow SDK

Airglow allows your coding agent to make custom apps on top of any website you're using. Describe the change and see it directly in your browser.

Airglow is a general purpose tool. You can create apps to add new features, automate workflows, modify interfaces, make custom dashboards.

Some example apps:

| Use case | App |
| -- | -- |
| **Adding features** | Button to run background research on a LinkedIn user |
| **Changing interfaces** | Hide Youtube Shorts |
| **Automating workflows** | Button to create a marketing campaign in Instagram from Spreadsheets data |

See more examples at [airglow.dev](https://airglow.dev)

## Quickstart

1. Install the **Airglow extension** from the Chrome Web Store:
   [chromewebstore.google.com/detail/airglow](https://chromewebstore.google.com/detail/airglow/angbnggmaccjdinfebjoibdklmckinfb)

   Ready-made apps install straight from the extension's **Catalog** tab — no terminal needed.

2. To build your own apps, install the **Airglow host** (daemon + `airglow` CLI):

   ```bash
   curl -fsSL https://airglow.dev/install.sh | bash
   ```

   Then start your coding agent in the workspace it creates:

   ```bash
   cd ~/.airglow && claude
   > Create an app that hides YouTube Shorts
   ```

## Structure

```
airglow-sdk/
├── extension/         # Chrome extension source (WXT + React + Tailwind)
├── host/              # Native host: daemon + `airglow` CLI (one Bun binary)
│   └── seed/          # Canonical workspace seed (shared/, docs/, AGENTS.md, airglow.d.ts) → ~/.airglow
└── sdk/               # Canonical airglow.* SDK source (injected into apps)
```

Apps are developed in the `~/.airglow` workspace that the host seeds on install
(`apps/<id>/`). Developer guide: [`host/seed/AGENTS.md`](host/seed/AGENTS.md) and
[`host/seed/docs/`](host/seed/docs/).

## Build from source

The repo is source-only (no committed build artifacts). To run your own build
instead of the published extension + installer:

**Extension** — WXT + React + Tailwind. Requires [pnpm](https://pnpm.io).
```bash
cd extension
pnpm install
pnpm build        # → .output/chrome-mv3
```
Then load `extension/.output/chrome-mv3` at `chrome://extensions` → enable
Developer mode → **Load unpacked**. More in [`extension/README.md`](extension/README.md).

**Host** — one Bun binary (daemon + `airglow` CLI). Requires [Bun](https://bun.sh).
```bash
cd host
bun install
bun run src/main.ts install   # register the native-messaging host + seed ~/.airglow
```
Fully restart Chrome afterward so it picks up the native-messaging manifest; the
connector then auto-spawns the daemon. `bun run build` compiles a standalone
`dist/airglow` binary. More in [`host/README.md`](host/README.md).

----

> [!TIP]
> Airglow works best when you
> 1. First **think through** how the feature should look and behave
> 2. Then describe that **in detail**
