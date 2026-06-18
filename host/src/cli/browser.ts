// `airglow browser <cmd>` — drives the user's running Chrome through the
// daemon → connector → extension bridge. This is the agent's (and the
// maintainer's) only browser interface; there is no programmatic reload, no
// set-html, and no way to spawn a browser process from here.

import { probeDaemon } from '../daemon/index';

const HELP = `airglow browser — drive the running Chrome through the Airglow extension

Usage:
  airglow browser tabs                                   list open tabs grouped by window.
                                                         \`chatWindow: true\` = the window whose sidepanel
                                                         chat the user is talking from; its \`current:
                                                         true\` tab is the page the user is looking at.
                                                         \`role: "agent"\` = your own debug window.
  airglow browser open <url> [--background]              open a tab in the agent debug window
  airglow browser nav --tab N <url>                      navigate a tab
  airglow browser eval --tab N '<js>' [--main] [--frame S] [--app ID]
                                                         run JS (\`await\` supported). Default: CSP-exempt
                                                         USER_SCRIPT world (own window). --main: page
                                                         world, sees page globals, page CSP applies.
                                                         --app ID: run in app ID's world with its
                                                         \`airglow\` SDK defined, e.g.
                                                         --app ID 'await airglow.storage.get("k")'.
  airglow browser html --tab N [--selector CSS] [--frame S]
                                                         outerHTML (whole document by default)
  airglow browser shot --tab N                           screenshot → prints saved file path
  airglow browser close --tab N                          close a tab
  airglow browser logs [--level error] [--source <app>|daemon] [-n 50]
                                                         browser buffer + daemon log, merged by time.
                                                         --source daemon: just the daemon log.
  airglow browser targets                                connected browsers (multi-Chrome setups)

Network capture (reverse-engineering a site's API):
  airglow browser attach --tab N / detach --tab N        start/stop fetch+XHR capture on a tab
  airglow browser read [--url S] [--method POST] [--clear]
                                                         captured requests (compact)
  airglow browser entry --i N                            full request/response for one entry

Options:
  --browser <substr>    target a specific Chrome when several are connected
                        (matches the profile path from \`targets\`)
`;

interface ParsedArgs {
  cmd: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [cmd = '', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--main' || a === '--background' || a === '--clear') {
      flags[a.slice(2)] = true;
    } else if (a === '-n') {
      flags.n = rest[++i] ?? '';
    } else if (a.startsWith('--')) {
      flags[a.slice(2)] = rest[++i] ?? '';
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}

export async function runBrowserCli(argv: string[]): Promise<void> {
  const { cmd, flags, positional } = parseArgs(argv);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(HELP);
    process.exit(cmd ? 0 : 1);
  }

  const daemon = await probeDaemon();
  if (!daemon) {
    console.error('airglow daemon is not running. It starts automatically when Chrome (with the Airglow extension) is open.');
    process.exit(1);
  }

  const args: Record<string, unknown> = {};
  if (flags.browser) args.browser = flags.browser;
  // Forwarded so the daemon can attribute (and gate) agent-session commands.
  if (process.env.AIRGLOW_SESSION) args.sessionId = process.env.AIRGLOW_SESSION;

  const tab = flags.tab !== undefined ? Number(flags.tab) : undefined;

  switch (cmd) {
    case 'tabs':
    case 'targets':
      break;
    case 'open':
      if (!positional[0]) fail('usage: airglow browser open <url> [--background]');
      args.url = positional[0];
      args.active = !flags.background;
      break;
    case 'nav':
      if (tab === undefined || !positional[0]) fail('usage: airglow browser nav --tab N <url>');
      args.tabId = tab;
      args.url = positional[0];
      break;
    case 'eval':
      if (tab === undefined || !positional[0]) fail("usage: airglow browser eval --tab N '<js>' [--main] [--app ID]");
      args.tabId = tab;
      args.code = positional[0];
      if (flags.main) args.main = true;
      if (flags.frame) args.frame = flags.frame;
      if (flags.app) args.app = flags.app;
      break;
    case 'html':
      if (tab === undefined) fail('usage: airglow browser html --tab N [--selector CSS]');
      args.tabId = tab;
      if (flags.selector) args.selector = flags.selector;
      if (flags.frame) args.frame = flags.frame;
      break;
    case 'shot':
    case 'close':
    case 'attach':
    case 'detach':
      if (tab === undefined) fail(`usage: airglow browser ${cmd} --tab N`);
      args.tabId = tab;
      break;
    case 'logs':
      if (flags.level) args.level = flags.level;
      if (flags.source) args.source = flags.source;
      if (flags.n) args.n = flags.n;
      break;
    case 'read':
      if (flags.url) args.url = flags.url;
      if (flags.method) args.method = flags.method;
      if (flags.tab) args.tabId = tab;
      if (flags.clear) args.clear = true;
      break;
    case 'entry':
      if (flags.i === undefined) fail('usage: airglow browser entry --i N');
      args.i = Number(flags.i);
      break;
    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }

  const res = await fetch(`http://127.0.0.1:${daemon.port}/api/browser/${cmd}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body: any = await res.json().catch(() => ({ error: 'invalid response from daemon' }));

  if (body?.error) {
    console.error(`error: ${body.error}`);
    process.exit(1);
  }
  // `shot` prints just the file path (the chat UI and agents key off it);
  // everything else prints pretty JSON.
  if (cmd === 'shot' && body?.path) {
    console.log(body.path);
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
