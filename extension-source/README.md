# Airglow Chrome extension — source

WXT + React + Tailwind source for the Chrome extension. Edit files here, then run the export script to refresh [`../extension/`](../extension/).

## Develop

```bash
pnpm install
pnpm dev
pnpm chrome
```

## Export — rebuild `../extension/`

```bash
bash scripts/export-extension.sh
```

## Pre-push hook (for maintainers)

Refuses pushes when `extension/` is stale relative to `extension-source/`. Per-machine, opt-in — install with `bash scripts/install-hooks.sh`.

## Env

Build-time env vars are WXT-prefixed (`WXT_*`). See [`.env.example`](.env.example).
