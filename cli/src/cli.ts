import { newApp } from './new';
import { dev } from './dev';
import { upload } from './upload';

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
  case 'upload':
    upload({
      target: positional[0],
      appsDir: typeof flags['apps-dir'] === 'string' ? flags['apps-dir'] : undefined,
      cloudUrl: typeof flags.cloud === 'string' ? flags.cloud : undefined,
      visibility: typeof flags.visibility === 'string' ? flags.visibility : undefined,
      visibleTo: typeof flags['visible-to'] === 'string' ? flags['visible-to'] : undefined,
      publish: flags.publish === true,
      dryRun: flags['dry-run'] === true,
      yes: flags.yes === true,
      user: typeof flags.user === 'string' ? flags.user : undefined,
      password: typeof flags.password === 'string' ? flags.password : undefined,
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
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
  \x1b[1mupload <app> [options]\x1b[0m     \x1b[2mZip and upload an app to Airglow Cloud\x1b[0m

Run from inside the workspace (\x1b[36mcd airglow-apps\x1b[0m).

Options:
  --port N           Bind port (default 3222)
  --apps-dir D       Apps workspace directory (default cwd)
  --cloud URL        Cloud URL (default https://api.airglow.dev)
  --visibility MODE  production, dev, or hidden
  --publish          Publish uploaded ready version
  --dry-run          Print archive contents without uploading
  --yes              Confirm upload
  --help, -h         Show this message`);
}
