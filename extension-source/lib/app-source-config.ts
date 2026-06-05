const DEFAULT_OFFICIAL_APP_SOURCE_URL = 'https://api.airglow.dev';
const OFFICIAL_APP_SOURCE_URL = import.meta.env.WXT_OFFICIAL_APP_SOURCE_URL || DEFAULT_OFFICIAL_APP_SOURCE_URL;

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Official app source defaults to production so dev extension profiles receive
 * the same pre-installed apps as users. Override with WXT_OFFICIAL_APP_SOURCE_URL
 * when testing a local Airglow Cloud app source.
 */
export function getOfficialAppSourceUrl(): string {
  return trimTrailingSlash(OFFICIAL_APP_SOURCE_URL);
}
