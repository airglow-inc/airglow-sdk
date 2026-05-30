# Airglow apps

Apps are developed and hosted in this folder.

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
<app-slug>/       one app per directory; usually matches manifest.slug
shared/           code shared across apps
docs/             technical docs
scripts/          helper scripts
.env              secrets
```

Each app is a folder with fixed structure:
```
<app-slug>/
├── manifest.json   # App definition
├── userscripts/    # (Optional) Scripts injected into web pages
├── ui/             # (Optional) Dashboard UI
├── server/         # (Optional) Server functions
└── startup.ts      # (Optional) Startup script
```

Apps are loaded into Chrome extension at runtime via local Airglow dev server (`pnpm airglow dev`).  
For apps to work in browser, `pnpm airglow dev` must be running.

A folder is identified as an app by its `manifest.json`.
Each app has a unique opaque `manifest.id` for runtime namespaces, routes, logs, and disabled-app state.
The directory name and `manifest.slug` are human-readable labels and are not required to be globally unique.

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
