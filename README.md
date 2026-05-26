# Airglow SDK

Airglow allows your coding agent to add features to any website just by describing them.

| Popular usecases | Example |
| --- | --- |
| Add custom features | Run background research on a LinkedIn user |
| Modify interfaces | Hide YouTube Shorts |
| Automate work | Populate a bookkeeping spreadsheet from email |

## Structure

```
airglow-sdk/
├── airglow-apps/   # Develop apps here — see airglow-apps/README.md
├── extension/      # Chrome extension
└── cli/            # CLI to run local Airglow apps
```

## Quickstart

1. Install Airglow extension (see [`extension/README.md`](extension/README.md))

2. Ask a coding agent to build a feature
```bash
cd airglow-apps
claude
>> "Create an app to hide news feed on x.com"
```

----

> [!TIP]
> Airglow works best when you
> 1. First **think through** how the feature should look and behave
> 2. Then describe that **in detail**


Developer guide [`airglow-apps/README.md`](airglow-apps/README.md)
