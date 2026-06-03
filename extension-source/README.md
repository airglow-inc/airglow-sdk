# Airglow Chrome extension — source

WXT + React + Tailwind source for the Chrome extension. Edit files here, then run the export script to refresh the [`../extension/`](../extension/) directory (the built MV3 bundle that users load via "Load unpacked").

## Develop

```bash
pnpm install           # one-time
pnpm dev               # wxt dev server on :3100, hot reload
pnpm chrome            # launch Chrome with the dev build pre-loaded (CDP on :9222)
```

## Export — rebuild `../extension/`

```bash
bash scripts/export-extension.sh
```

Runs `pnpm build` and copies the MV3 output into `../extension/`, then stamps a content hash into `manifest.json` as `airglow_build_hash`. Commit the result. CI (`.github/workflows/extension-sync.yml`) fails any PR where `extension/` doesn't match what `extension-source/` produces.

## Pre-push hook (optional, recommended for maintainers)

```bash
bash scripts/install-hooks.sh
```

Installs a local `.git/hooks/pre-push` that refuses pushes when `extension/` is stale. Per-machine, opt-in — not committed to the repo. Without it, only PR-level CI catches drift; direct pushes to `main` only get a red X after the fact.

## Env

Build-time env vars are WXT-prefixed (`WXT_*`). See [`.env.example`](.env.example). Defaults in code are fine for production — no secrets are baked into the bundle.
