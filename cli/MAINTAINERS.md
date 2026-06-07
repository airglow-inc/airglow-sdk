# Airglow CLI — Maintainer Commands

Commands in this document are not shown in `airglow --help` and are not part of the public developer surface. They require Airglow Cloud admin credentials and are intended for maintainers publishing apps to the cloud.

## `airglow upload`

Zips an app and uploads it to Airglow Cloud via the admin API.

```
airglow upload <app-id-or-path> [options]
```

`<app-id-or-path>` is either a manifest `id` (searched recursively under the apps dir) or a path to an app directory containing `manifest.json`.

### Options

| Flag | Description |
|---|---|
| `--apps-dir D` | Apps workspace directory (default cwd) |
| `--cloud URL` | Cloud URL (default `https://api.airglow.dev`, overridable via `AIRGLOW_CLOUD_URL`) |
| `--visibility MODE` | `production` (alias `prod`, `public`), `development` (alias `dev`), or `hidden` (alias `hide`) — overrides `manifest.visibility` |
| `--visible-to EMAIL` | After `--publish`, assert the uploaded app is visible to this email via the manifests endpoint |
| `--publish` | Publish the uploaded version after upload |
| `--dry-run` | Print archive contents without uploading |
| `--yes` | Confirm upload (otherwise prints a summary and exits) |
| `--user NAME` | Admin user (default `airglow`, overridable via `AIRGLOW_ADMIN_USER`) |
| `--password PASS` | Admin password (overridable via `AIRGLOW_ADMIN_PASSWORD`) — prefer the env var; CLI flag leaks into shell history |

### Environment variables

| Var | Purpose |
|---|---|
| `AIRGLOW_CLOUD_URL` | Cloud base URL |
| `AIRGLOW_ADMIN_USER` | Admin user for Basic auth (default `airglow`) |
| `AIRGLOW_ADMIN_PASSWORD` | **Required.** Admin password for Basic auth |

### Endpoints hit

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/apps/upload` | Upload zipped archive, returns `{ appKey, versionKey }` |
| `POST` | `/api/admin/apps/<appKey>/versions/<versionKey>/publish` | Publish version (only with `--publish`) |
| `GET` | `/api/apps/manifests` | Visibility check (only with `--publish` and either `--visible-to` or `--visibility development`) |

All admin endpoints use HTTP Basic auth.

### Visibility model

| Mode | Audience |
|---|---|
| `public` (alias `production`) | All extension users |
| `development` | Scoped to dev test accounts (`test@airglow.dev` by default) |
| `hidden` | Not surfaced to anyone |

### Archive contents

`upload` collects files from the app root and the sibling `shared/` directory (mounted under `shared/` in the archive). Excluded:

- Directories: `node_modules`, `.git`, `.airglow`, `.next`, `dist`, `build`, `coverage`, and any dotfile dir
- Files: `.env`, `.env.local`, `.env.production`, `.env.production.local`, and any dotfile

The on-disk `manifest.json` is replaced in the archive with a re-serialized copy reflecting any CLI `--visibility` override.

### Examples

```bash
# Dry run — see what would be uploaded
airglow upload my-app --dry-run

# Upload + publish to production
AIRGLOW_ADMIN_PASSWORD=... airglow upload my-app --visibility production --publish --yes

# Upload to dev users and verify visibility to test@airglow.dev
AIRGLOW_ADMIN_PASSWORD=... airglow upload my-app --visibility development --publish --yes
```
