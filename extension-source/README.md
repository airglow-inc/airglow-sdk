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

To point the ready-to-load extension at a local Airglow Cloud while testing the
side panel private app flow:

```bash
WXT_CLOUD_APP_SOURCE_URL=http://127.0.0.1:3002 pnpm export
```

Without that override, exported builds use the current public MVP endpoint:
`https://mvp-api.airglow.dev`.

## Runtime UX Approval

Apps still need manifest capabilities for privileged SDK calls. Browser-surface
actions that open tabs, open windows, or launch auth windows also require a
runtime user approval prompt before the background script calls Chrome UX APIs.
Generated private apps are read-only by default and do not receive those
capabilities.

## Pre-push hook (for maintainers)

Refuses pushes when `extension/` is stale relative to `extension-source/`. Per-machine, opt-in — install with `bash scripts/install-hooks.sh`.

## Env

Build-time env vars are WXT-prefixed (`WXT_*`). See [`.env.example`](.env.example).
