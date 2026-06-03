# Airglow apps

Apps are developed and hosted in this folder.

> [!NOTE]
> Airglow apps should be built by your coding agent — it installs deps and starts the dev
> server on its own. You shouldn't need to run these manually.

To run Airglow apps, install dependencies and start a dev server.
```bash
pnpm install
pnpm airglow dev     # localhost:3222
```

## Workspace layout

```
<app-id>/         one app per directory
shared/           code shared across apps
docs/             technical docs
scripts/          helper scripts
.env              secrets
```

Each app is a folder with fixed structure:
```
<app-id>/
├── manifest.json   # App definition
├── userscripts/    # (Optional) Scripts injected into web pages
├── ui/             # (Optional) Dashboard UI
├── server/         # (Optional) Server functions
└── startup.ts      # (Optional) Startup script
```

A folder is identified as an app by its `manifest.json`. Apps are served to the
extension by the dev server (`pnpm airglow dev`), which must be running for apps
to work in the browser.

## App Structure

Apps are developed in TypeScript. Each app has 5 main parts.

- **Manifest** (`manifest.json`) - App metadata and permissions.
- **Userscripts** (`userscripts/`) - Code that runs on web pages. Can read website data.
- **UI** (`ui/`) - Custom dashboard. Supports React + Tailwind.
- **Server functions** (`server/`) - Server side functions that run locally.
- **Startup** (`startup.ts`) - App startup script.

Apps use the Airglow SDK ([`docs/sdk-reference.md`](docs/sdk-reference.md)) for storage
and internal communication. Apps are isolated from each other and have no direct access
to the Chrome API.

Technical documentation: [`docs/app-developer-guide.md`](docs/app-developer-guide.md).
