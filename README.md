# Airglow SDK

Airglow allows your coding agent to make custom apps on top of any website you're using. Describe the change and see it directly in your browser.

Airglow is a general purpose tool. You can create apps to add new functionality, automate interactions, extract data, modify interfaces, make custom dashboards.

See examples at [airglow.dev](https://airglow.dev)

| Feature | Example |
| --- | --- |
| Add functionality | Run background research on a LinkedIn user |
| Change interfaces | Hide YouTube Shorts |
| Automate workflows | Translate marketing campaign into another language |


## Quickstart

1. Install Airglow extension (see [`extension/README.md`](extension/README.md))

2. Verify installation by opening a dashboard  
(`chrome-extension://comikpjjijckpjkobpkkpnnhlcpmagic/dashboard.html`)

3. Ask a coding agent to build a feature
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

Developer guide [`airglow-apps/README.md`](airglow-apps/README.md)

----

> [!TIP]
> Airglow works best when you
> 1. First **think through** how the feature should look and behave
> 2. Then describe that **in detail**
