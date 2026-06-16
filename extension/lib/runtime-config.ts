// In dev builds, auto-seed the signed-in identity so local development skips
// the email gate *and* the Google sign-in gate. `import.meta.env.DEV` is a
// literal boolean Vite replaces at build time, so the prod branch tree-shakes
// away — these strings never reach the production bundle.
const DEV_USER_EMAIL: string | undefined = import.meta.env.DEV
  ? 'test@airglow.cc'
  : undefined;
// Mirrors the server's gaia_<sub> userId shape so dev telemetry/legacy headers
// look like a real account. Stable across reloads so usage history is coherent.
const DEV_USER_ID: string | undefined = import.meta.env.DEV
  ? 'gaia_dev'
  : undefined;

export const runtimeConfig = {
  localManifestPollMs: 5000,
  devUserEmail: DEV_USER_EMAIL,
  devUserId: DEV_USER_ID,
} as const;
