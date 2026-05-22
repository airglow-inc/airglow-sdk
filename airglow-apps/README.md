# Airglow apps workspace

Each directory with a `manifest.json` is one app, loaded into the Airglow Chrome extension at runtime.

## Quickstart

1. Install the extension — see [`../extension/README.md`](../extension/README.md).
2. Install deps and start the dev server:
   ```bash
   pnpm install
   pnpm airglow dev
   ```
3. Ask the agent to build something:
   ```bash
   claude
   >> "Build me an app that adds AI-generated tags to every HN title"
   ```

## What you can build

Airglow apps live inside a Chrome extension. They can:

- **Modify any web page** — add buttons, change layouts, read or extract data.
- **Run AI over what the user is looking at** — tag, summarize, translate, classify.
- **Hav a dedicated dashboard** - can be a settings page or a full-fledged website on React.
- **Act on the user's behalf across services** — make requests as the logged-in user (Gmail, Notion, Linear, Calendar, anything), or via API keys for services that need them (OpenAI, Anthropic).
- **Reshape browsing itself** — redirect distracting sites somewhere else, embed websites into another websites.

## Workspace layout

```
<app-id>/         one app per directory
shared/           code shared across apps
docs/             technical docs
scripts/          chrome launcher, composio tools
.env              secrets
```

Technical documentation: [`docs/app-developer-guide.md`](docs/app-developer-guide.md).
