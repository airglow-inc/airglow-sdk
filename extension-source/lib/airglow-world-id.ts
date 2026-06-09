const MAX_WORLD_ID_LENGTH = 128;

export function airglowUserScriptWorldId(appId: string): string {
  const safeAppId = appId.replace(/[^A-Za-z0-9_]/g, '_');
  return `airglow_${safeAppId}`.slice(0, MAX_WORLD_ID_LENGTH);
}
