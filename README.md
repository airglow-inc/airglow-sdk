# Airglow SDK

Airglow allows your coding agent to make custom apps on top of any website you're using. Describe the change and see it directly in your browser.

Airglow is a general purpose tool. You can create apps to add new features, automate workflows, modify interfaces, make custom dashboards.

Some examples:
- **Add functionality:** Run background research on a LinkedIn user
- **Change interfaces:** Hide Youtube Shorts
- **Automate workflows:** Create a marketing campaign in Instagram from Spreadsheets data

See examples at [airglow.dev](https://airglow.dev)

## Quickstart

1. Install Airglow extension (see [`extension/README.md`](extension/README.md))

2. Start a dev server
```bash
cd airglow-apps
pnpm install
pnpm airglow dev
```

3. Verify installation by opening a dashboard  
(`chrome-extension://comikpjjijckpjkobpkkpnnhlcpmagic/dashboard.html`)

4. Ask a coding agent to build a feature
```bash
cd airglow-apps
claude
>> "Create an app to hide news feed on x.com"
```

## Structure

```
airglow-sdk/
├── airglow-apps/   # Your agent should develop apps here, see airglow-apps/README.md
├── extension/      # Chrome extension
└── cli/            # CLI to run Airglow apps locally
```

## Included in this export

- Hosted official-app server code lives in Airglow Cloud; the SDK workspace keeps local example apps and the ready-to-load extension.
- `airglow.llm.anthropic.messages(...)` routes Anthropic-compatible calls through the Airglow Cloud LLM gateway, keeping provider keys server-side.
- CLI dev-server bundling is hardened against undeclared files, path traversal, shell interpolation, and unsafe native-bridge helper commands.
- The exported extension includes dashboard feedback and update/reload buttons.

Developer guide [`airglow-apps/README.md`](airglow-apps/README.md)

----

> [!TIP]
> Airglow works best when you
> 1. First **think through** how the feature should look and behave
> 2. Then describe that **in detail**
