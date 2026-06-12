import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Module from 'node:module';

type UploadOptions = {
  target?: string;
  appsDir?: string;
  cloudUrl?: string;
  visibility?: string;
  visibleTo?: string;
  publish?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  user?: string;
  password?: string;
};

type AppVisibility = 'public' | 'development' | 'hidden';

const DEFAULT_CLOUD_URL = 'https://api.airglow.dev';
const DEFAULT_DEV_EMAIL = 'test@airglow.dev';
const BLOCKED_DIRS = new Set(['node_modules', '.git', '.airglow', '.next', 'dist', 'build', 'coverage']);
const BLOCKED_FILES = new Set(['.env', '.env.local', '.env.production', '.env.production.local']);

export async function upload(opts: UploadOptions): Promise<void> {
  if (!opts.target) throw new Error('Usage: airglow upload <app-id-or-path> [--visibility production|dev|hidden]');

  const appsDir = resolve(opts.appsDir || process.cwd());
  const appRoot = await resolveAppRoot(appsDir, opts.target);
  const manifest = JSON.parse(await readFile(join(appRoot, 'manifest.json'), 'utf-8')) as Record<string, unknown>;
  const appId = typeof manifest.id === 'string' && manifest.id.trim() ? manifest.id.trim() : basename(appRoot);
  const visibility = opts.visibility ? parseVisibility(opts.visibility) : undefined;
  if (visibility) manifest.visibility = visibility;

  const files = await collectUploadFiles(appsDir, appRoot, manifest);
  const archiveBytes = zipFiles(files);
  const archiveName = `${appId}.zip`;

  if (opts.dryRun) {
    console.log(`Archive: ${archiveName}`);
    console.log(`App:     ${appId}`);
    console.log(`Files:   ${Object.keys(files).length}`);
    console.log(`Bytes:   ${archiveBytes.byteLength}`);
    for (const path of Object.keys(files).sort()) console.log(`  ${path}`);
    return;
  }

  if (!opts.yes) {
    console.log(`Uploading ${appId} (${Object.keys(files).length} files, ${archiveBytes.byteLength} bytes).`);
    console.log('Pass --yes to confirm.');
    return;
  }

  const cloudUrl = normalizeCloudUrl(opts.cloudUrl || process.env.AIRGLOW_CLOUD_URL || DEFAULT_CLOUD_URL);
  const authHeader = basicAuthHeader({
    user: opts.user || process.env.AIRGLOW_ADMIN_USER || 'airglow',
    password: opts.password || process.env.AIRGLOW_ADMIN_PASSWORD,
  });
  const uploadResult = await uploadArchive({
    cloudUrl,
    authHeader,
    archiveName,
    archiveBytes,
  });

  console.log(`Uploaded ${uploadResult.versionKey}.`);

  if (opts.publish) {
    await publishVersion({ cloudUrl, authHeader, appKey: uploadResult.appKey, versionKey: uploadResult.versionKey });
    console.log(`Published ${uploadResult.versionKey}.`);
  }

  if (opts.visibleTo && opts.publish) {
    await assertManifestVisible({
      cloudUrl,
      authHeader,
      appId: uploadResult.appKey,
      userEmail: opts.visibleTo,
    });
    console.log(`Verified ${uploadResult.appKey} is visible to ${opts.visibleTo}.`);
  } else if (visibility === 'development' && opts.publish) {
    await assertManifestVisible({
      cloudUrl,
      authHeader,
      appId: uploadResult.appKey,
      userEmail: DEFAULT_DEV_EMAIL,
    });
    console.log(`Verified ${uploadResult.appKey} is visible to ${DEFAULT_DEV_EMAIL}.`);
  }
}

async function resolveAppRoot(appsDir: string, target: string): Promise<string> {
  const direct = isAbsolute(target) ? target : resolve(appsDir, target);
  if (await hasManifest(direct)) return direct;

  const found = await findAppById(appsDir, target, 0);
  if (found) return found;
  throw new Error(`app not found: ${target}`);
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    const s = await stat(join(dir, 'manifest.json'));
    return s.isFile();
  } catch {
    return false;
  }
}

async function findAppById(root: string, appId: string, depth: number): Promise<string | null> {
  if (depth > 4) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || BLOCKED_DIRS.has(entry.name) || entry.name === 'shared') continue;
    const dir = join(root, entry.name);
    const manifestPath = join(dir, 'manifest.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { id?: unknown };
      if (manifest.id === appId) return dir;
      continue;
    } catch {}
    const nested = await findAppById(dir, appId, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function collectUploadFiles(
  appsDir: string,
  appRoot: string,
  manifest: Record<string, unknown>,
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = Object.create(null);
  await collectDir(appRoot, appRoot, files, '');
  files['manifest.json'] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

  const sharedRoot = join(appsDir, 'shared');
  if (existsSync(sharedRoot) && statSync(sharedRoot).isDirectory()) {
    await collectDir(sharedRoot, sharedRoot, files, 'shared');
  }
  return files;
}

async function collectDir(
  root: string,
  dir: string,
  files: Record<string, Uint8Array>,
  prefix: string,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || BLOCKED_DIRS.has(entry.name)) continue;
    if (BLOCKED_FILES.has(entry.name)) continue;
    const absolutePath = join(dir, entry.name);
    const rel = normalizeArchivePath(prefix ? join(prefix, relative(root, absolutePath)) : relative(root, absolutePath));
    if (!rel) continue;
    if (entry.isDirectory()) {
      await collectDir(root, absolutePath, files, prefix);
      continue;
    }
    if (!entry.isFile()) continue;
    files[rel] = new Uint8Array(await readFile(absolutePath));
  }
}

function normalizeArchivePath(path: string): string {
  return path.split(sep).join('/');
}

function zipFiles(files: Record<string, Uint8Array>): Uint8Array {
  const requireFromWorkspace = Module.createRequire(join(process.cwd(), 'package.json'));
  const { zipSync } = requireFromWorkspace('fflate') as { zipSync(input: Record<string, Uint8Array>, opts?: unknown): Uint8Array };
  return zipSync(files, { mtime: new Date('1980-01-01T00:00:00.000Z') });
}

function parseVisibility(value: string): AppVisibility {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'production' || normalized === 'prod' || normalized === 'public') return 'public';
  if (normalized === 'development' || normalized === 'dev') return 'development';
  if (normalized === 'hidden' || normalized === 'hide') return 'hidden';
  throw new Error('visibility must be production, dev, or hidden');
}

function normalizeCloudUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function basicAuthHeader(input: { user: string; password?: string }): string {
  if (!input.password) throw new Error('AIRGLOW_ADMIN_PASSWORD or --password is required');
  return `Basic ${Buffer.from(`${input.user}:${input.password}`).toString('base64')}`;
}

async function uploadArchive(input: {
  cloudUrl: string;
  authHeader: string;
  archiveName: string;
  archiveBytes: Uint8Array;
}): Promise<{ appKey: string; versionKey: string }> {
  const form = new FormData();
  const archiveBuffer = input.archiveBytes.buffer.slice(
    input.archiveBytes.byteOffset,
    input.archiveBytes.byteOffset + input.archiveBytes.byteLength,
  ) as ArrayBuffer;
  form.set('archive', new Blob([archiveBuffer], { type: 'application/zip' }), input.archiveName);
  const res = await fetch(`${input.cloudUrl}/api/admin/apps/upload`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: input.authHeader,
      Origin: input.cloudUrl,
    },
    body: form,
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${body?.error || JSON.stringify(body)}`);
  return body as { appKey: string; versionKey: string };
}

async function publishVersion(input: {
  cloudUrl: string;
  authHeader: string;
  appKey: string;
  versionKey: string;
}): Promise<void> {
  const res = await fetch(
    `${input.cloudUrl}/api/admin/apps/${encodeURIComponent(input.appKey)}/versions/${encodeURIComponent(input.versionKey)}/publish`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: input.authHeader,
        Origin: input.cloudUrl,
      },
    },
  );
  const body = await readJson(res);
  if (!res.ok) throw new Error(`publish failed (${res.status}): ${body?.error || JSON.stringify(body)}`);
}

async function assertManifestVisible(input: { cloudUrl: string; authHeader: string; appId: string; userEmail: string }): Promise<void> {
  const res = await fetch(`${input.cloudUrl}/api/apps/manifests`, {
    headers: {
      Authorization: input.authHeader,
      'X-Airglow-User-Id': 'airglow-cli',
      'X-Airglow-User-Email': input.userEmail,
    },
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`manifest check failed (${res.status}): ${JSON.stringify(body)}`);
  if (!Array.isArray(body) || !body.some((manifest) => manifest?.id === input.appId)) {
    throw new Error(`manifest check failed: ${input.appId} is not visible to ${input.userEmail}`);
  }
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
