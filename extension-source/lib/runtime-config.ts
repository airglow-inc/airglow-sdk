// In dev builds, auto-seed USER_EMAIL_KEY so apps don't trip the email gate
// during local development. `import.meta.env.DEV` is a literal boolean Vite
// replaces at build time, so the prod branch tree-shakes away — this string
// never reaches the production bundle.
const DEV_USER_EMAIL: string | undefined = import.meta.env.DEV
  ? 'test@airglow.cc'
  : undefined;

export const runtimeConfig = {
  localManifestPollMs: 5000,
  devUserEmail: DEV_USER_EMAIL,
} as const;
