# Airglow Chrome extension

WXT + React + Tailwind source for the Chrome extension. This directory holds the
source only — the build output (`.output/`) is gitignored and never committed.

## Develop

```bash
pnpm install
pnpm dev      # WXT dev server → .output/chrome-mv3-dev (load unpacked)
pnpm chrome   # launch Chrome with the dev build loaded
```

## Build & package for the Chrome Web Store

```bash
pnpm build    # → .output/chrome-mv3
pnpm zip      # → .output/airglow-ext-prod.zip (manifest `key` stripped, ready to upload)
```

Cut a release with `pnpm bump <version>` — it bumps `package.json`, builds, zips,
commits, and tags `vX.Y.Z`. See the repo's `CLAUDE.local.md` for the full flow.

## Env

Build-time env vars are WXT-prefixed (`WXT_*`). See [`.env.example`](.env.example).
