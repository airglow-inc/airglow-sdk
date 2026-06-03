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
├── airglow-apps/      # Your agent should develop apps here, see airglow-apps/README.md
├── extension/         # Chrome extension — built output, load this with "Load unpacked"
├── extension-source/  # Chrome extension source (WXT + React + Tailwind); rebuilds extension/
└── cli/               # CLI to run Airglow apps locally
```

Developer guide [`airglow-apps/README.md`](airglow-apps/README.md)

## Building the extension

End users don't need this — `extension/` is the built bundle they load. Edit `extension-source/` only if you're modifying the extension itself (dashboard, background worker, content scripts).

```bash
cd extension-source
pnpm install
pnpm dev                                 # WXT dev server with hot reload
bash scripts/export-extension.sh         # rebuild ../extension/ for commit
```

See [`extension-source/README.md`](extension-source/README.md) for the full workflow, including the optional pre-push hook that refuses pushes with a stale `extension/`.

----

> [!TIP]
> Airglow works best when you
> 1. First **think through** how the feature should look and behave
> 2. Then describe that **in detail**
