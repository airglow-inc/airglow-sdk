import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const APP_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function toTitleCase(kebab: string): string {
  return kebab.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export function newApp(appId: string) {
  if (!APP_ID_PATTERN.test(appId)) {
    console.error(`Invalid app id "${appId}". Use lowercase letters, digits, and dashes (e.g. my-app).`);
    process.exit(1);
  }

  if (!existsSync(join(process.cwd(), 'shared'))) {
    console.error('Not in an airglow workspace. Run from inside airglow-apps/.');
    process.exit(1);
  }

  const appDir = join(process.cwd(), appId);

  if (existsSync(appDir)) {
    console.error(`${appId}/ already exists`);
    process.exit(1);
  }

  const name = toTitleCase(appId);
  mkdirSync(appDir);
  mkdirSync(join(appDir, 'ui'));

  writeFileSync(join(appDir, 'manifest.json'), JSON.stringify({
    id: appId,
    name,
    version: '0.1.0',
    description: '',
    tags: [],
  }, null, 2) + '\n');

  writeFileSync(join(appDir, 'package.json'), JSON.stringify({
    name: appId,
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

  console.log(`Created ${appId}/`);
}
