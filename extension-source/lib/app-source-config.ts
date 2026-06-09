const DEFAULT_CLOUD_APP_SOURCE_URL = 'https://mvp-api.airglow.dev';
// WXT_OFFICIAL_APP_SOURCE_URL kept as backward-compat alias (was the original
// env var name). New code should set WXT_CLOUD_APP_SOURCE_URL.
const CLOUD_APP_SOURCE_URL = import.meta.env.WXT_CLOUD_APP_SOURCE_URL
  || import.meta.env.WXT_OFFICIAL_APP_SOURCE_URL
  || DEFAULT_CLOUD_APP_SOURCE_URL;

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Cloud app source defaults to production so dev extension profiles receive
 * the same pre-installed apps as users. Override with WXT_CLOUD_APP_SOURCE_URL
 * when testing a local Airglow Cloud app source.
 */
export function getCloudAppSourceUrl(): string {
  return trimTrailingSlash(CLOUD_APP_SOURCE_URL);
}
