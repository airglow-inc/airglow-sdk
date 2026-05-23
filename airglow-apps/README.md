# Airglow apps workspace

Apps are developed and hosted in this folder.
Each directory with a `manifest.json` is one app, loaded into the Airglow Chrome extension at runtime.

## What you can build

Airglow apps live inside a Chrome extension. With Airglow you can:

- **Modify any web page** — add buttons, change layouts, read or extract data.
- **Act on user's behalf across services** — make requests as the logged-in user (Gmail, Notion, Linear, Calendar, anything), or via API keys (OpenAI, Anthropic).
- **Run AI directly on the page** — research, summarize, translate, classify.
- **Create dashboards** - can be a settings page or a full-fledged website on React.
- **Reshape browsing itself** — redirect distracting websites, hide annoying elements, embed pages within other pages.

## Quickstart

1. Install the extension — see [`../extension/README.md`](../extension/README.md).
2. Open **extension dashboard** in browser (`chrome-extension://comikpjjijckpjkobpkkpnnhlcpmagic/dashboard.html`)
3. Ask an agent to build something:
   ```bash
   claude
   >> "Build me an app that adds AI-generated tags to every HN title"
   ```

> [!NOTE]
> The agent installs dependencies and starts the dev server on its own.

#### Running manually (without an agent)

Under the hood, the agent starts the development server:

```bash
pnpm install         # install dependencies
pnpm airglow dev     # start the dev server on http://127.0.0.1:3001
```

## Workspace layout

```
<app-id>/         one app per directory
shared/           code shared across apps
docs/             technical docs
scripts/          helper scripts
.env              secrets
```

Technical documentation: [`docs/app-developer-guide.md`](docs/app-developer-guide.md).
