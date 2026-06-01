# Airglow apps

Apps are developed and hosted in this folder.
Official app sources live in the `airglow-inc/apps` repository and are deployed through Airglow Cloud; this workspace is for local/user-developed apps and examples.

> [!NOTE]
> It is expected that you make apps using a coding agent. The project is structured this way, including `AGENTS.md`

To run Airglow apps, install dependencies and start a dev server.
```bash
pnpm install         # install dependencies
pnpm airglow dev     # start the dev server on localhost:3001
```

> [!NOTE]
> The agent is supposed to install dependencies and start the dev server on its own.

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

Apps are loaded into Chrome extension at runtime via local Airglow dev server (`pnpm airglow dev`).  
For apps to work in browser, `pnpm airglow dev` must be running.

A folder is identified as an app by its `manifest.json`.

## App Structure

Apps are developed in TypeScript. Each app has 5 main parts.

- **Manifest** (`manifest.json`) - App metadata and permissions.
- **Userscripts** (`userscripts/`) - Code that runs on web pages. Can read website data.
- **UI** (`ui/`) - Custom dashboard. Supports React + Tailwind. 
- **Server functions** (`server/`) - Server side functions that run locally.
- **Startup** (`startup.ts`) - App startup script.

Airglow apps are similar in structure to websites, having frontend (UI) and backend (Server functions).
In fact, you can host a local website using Airglow.

Apps use Airglow SDK ([`docs/sdk-reference.md`](docs/sdk-reference.md)) for storage and internal communication.  
Apps are isolated from each other and have no direct access to Chrome API.

Technical documentation: [`docs/app-developer-guide.md`](docs/app-developer-guide.md).
