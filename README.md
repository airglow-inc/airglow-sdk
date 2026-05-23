# Airglow SDK

Airglow is a platform to vibecode website features. Build apps that inject UI, automate workflows, and connect services — all running through a browser extension.

**Why Airglow:** Describe the feature → get working result directly in your browser.

> [!NOTE]
> Airglow works well for non-technical users. **Ask your coding agent** to help you install Airglow.

## Structure

```
airglow-sdk/
├── extension/      # Chrome extension
├── cli/            # CLI to run local Airglow apps
└── airglow-apps/   # Develop apps here — see airglow-apps/README.md
```

## Quickstart

1. Install Airglow extension (see [`extension/README.md`](extension/README.md))

2. Ask a coding agent to build a feature
```bash
cd airglow-apps
claude
>> "Create an app to hide news feed on x.com"
```

3. Check results in your browser

4. Refine your app

----

> [!TIP]
> Airglow works best when you
> 1. First **think through** how the feature should look and behave
> 2. Then describe that **in detail**


Developer guide [`airglow-apps/README.md`](airglow-apps/README.md)
