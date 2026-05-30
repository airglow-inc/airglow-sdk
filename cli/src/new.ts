import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const APP_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function toTitleCase(kebab: string): string {
  return kebab.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function newAppId(): string {
  return `app_${randomUUID()}`;
}

export function newApp(appSlug: string) {
  if (!APP_SLUG_PATTERN.test(appSlug)) {
    console.error(`Invalid app slug "${appSlug}". Use lowercase letters, digits, and dashes (e.g. my-app).`);
    process.exit(1);
  }

  if (!existsSync(join(process.cwd(), 'shared'))) {
    console.error('Not in an airglow workspace. Run from inside airglow-apps/.');
    process.exit(1);
  }

  const appDir = join(process.cwd(), appSlug);

  if (existsSync(appDir)) {
    console.error(`${appSlug}/ already exists`);
    process.exit(1);
  }

  const name = toTitleCase(appSlug);
  mkdirSync(appDir);
  mkdirSync(join(appDir, 'ui'));

  writeFileSync(join(appDir, 'manifest.json'), JSON.stringify({
    id: newAppId(),
    slug: appSlug,
    name,
    version: '0.1.0',
    description: '',
    tags: [],
  }, null, 2) + '\n');

  writeFileSync(join(appDir, 'package.json'), JSON.stringify({
    name: appSlug,
    private: true,
  }, null, 2) + '\n');

  writeFileSync(join(appDir, 'ui', 'App.tsx'), `import { createRoot } from 'react-dom/client';

function App() {
  return (
    <div className="p-10">
      <h1 className="text-2xl font-bold mb-2">${name}</h1>
      <p className="text-[var(--fg-secondary)]">Edit ui/App.tsx to get started.</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
`);

  writeFileSync(join(appDir, 'ui', 'globals.css'), `@import "../../shared/theme/tailwind-theme.css";
`);

  console.log(`Created ${appSlug}/`);
}
