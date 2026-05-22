# Airglow SDK

Airglow is a platform to vibecode and share web app integrations. Build small apps that inject UI, automate workflows, and connect services — all running through a browser extension.

## Structure

```
airglow-sdk/
├── extension/      # Chrome extension
├── cli/            # CLI to run local Airglow apps
└── airglow-apps/   # Develop apps here — see airglow-apps/README.md
```

## Quick start

1. Install Airglow extension (see [`extension/README.md`](extension/README.md))

2. Start development server
```bash
cd airglow-apps
pnpm install
pnpm airglow new <app-name>
pnpm airglow dev
```

3. Start coding agent and develop your first app
```bash
cd airglow-apps
claude
>> "Create an app to hide news feed on x.com"
```
