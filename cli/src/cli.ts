import { newApp } from './new';
import { dev } from './dev';

const [,, command, ...rest] = process.argv;

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = args[i + 1];
        i += 1;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else if (arg === '-h') {
      flags.help = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseFlags(rest);

switch (command) {
  case 'new':
    if (!positional[0]) {
      console.error('Usage: airglow new <app-id>   (lowercase letters, digits, dashes; e.g. my-app)');
      process.exit(1);
    }
    newApp(positional[0]);
    break;
  case 'dev':
    dev({
      port: typeof flags.port === 'string' ? Number(flags.port) : undefined,
      appsDir: typeof flags['apps-dir'] === 'string' ? flags['apps-dir'] : undefined,
    });
    break;
  case '--help':
  case '-h':
  case 'help':
  default:
    // Keep this help text in sync with cli/README.md (the fenced block under "Run it from").
    console.log(`
  ◆ \x1b[1mairglow\x1b[0m — build apps for the web

Commands:
  \x1b[1mnew <app-id>\x1b[0m              \x1b[2mScaffold a new app (app-id: lowercase a-z, digits, dashes)\x1b[0m
  \x1b[1mdev [--port N] [--apps-dir D]\x1b[0m  \x1b[2mRun apps locally with hot reload\x1b[0m

Run from inside the workspace (\x1b[36mcd airglow-apps\x1b[0m).

Options:
  --port N           Bind port (default 3001, or AIRGLOW_DEV_SERVER_PORT env)
  --apps-dir D       Apps workspace directory (default cwd)
  --help, -h         Show this message`);
}
