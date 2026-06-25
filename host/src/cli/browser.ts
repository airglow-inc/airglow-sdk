// `airglow browser <cmd>` — drives the user's running Chrome through the
// daemon → connector → extension bridge. This is the agent's (and the
// maintainer's) only browser interface; there is no programmatic reload, no
// set-html, and no way to spawn a browser process from here.

import { requireDaemon } from './daemon';

const HELP = `airglow browser — drive the running Chrome through the Airglow extension

Usage:
  airglow browser tabs                                   list open tabs grouped by window.
                                                         \`chatWindow: true\` = the window whose sidepanel
                                                         chat the user is talking from; its \`current:
                                                         true\` tab is the page the user is looking at.
                                                         \`role: "agent"\` = your OWN window (open/test here);
                                                         \`"agent-other"\` = another agent's window (read-only);
                                                         \`"user"\` = the user's. Read any tab; act only in yours.
  airglow browser open <url> [--background]             open a tab in your own agent window (created on
                                                         first open, a colored "Airglow" tab group)
  airglow browser open --app <id> [--background]
                                                         open an app's UI fully wired (airglow.* live,
                                                         RPCs/storage work) as a top-level tab — then
                                                         eval/html/shot read it directly, no --frame.
                                                         Use this to test an app UI, not the bare
                                                         /api/apps/<id>/ui URL (unwired).
  airglow browser nav --tab N <url>                      navigate a tab
  airglow browser eval --tab N '<js>' [--main] [--frame S] [--app ID] [--timeout MS]
                                                         run JS (\`await\` supported). Default: USER_SCRIPT
                                                         world with debugger fallback on strict CSP pages.
                                                         --main: page world, sees page globals.
                                                         --app ID: run in app ID's world with its
                                                         \`airglow\` SDK defined, e.g.
                                                         --app ID 'await airglow.storage.get("k")'.
                                                         --timeout MS: default 8000, max 14000. A wedged
                                                         (CPU-pegged) page times out; raise for slow work.
  airglow browser html --tab N [--selector CSS] [--frame S]
                                                         outerHTML (whole document by default)
  airglow browser shot --tab N [--timeout MS]            screenshot → prints saved file path
                                                         (--timeout MS: default 8000, max 14000)
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

  const daemon = await requireDaemon();

  const args: Record<string, unknown> = {};
  if (flags.browser) args.browser = flags.browser;
  // Tie every command to one agent's own window (see agentSessionId).
  const sessionId = agentSessionId();
  if (sessionId) args.sessionId = sessionId;

  const tab = flags.tab !== undefined ? Number(flags.tab) : undefined;

  switch (cmd) {
    case 'tabs':
    case 'targets':
      break;
    case 'open':
      if (flags.app) {
        // Open the app's UI as a top-level tab. The app-ui-bridge content script
        // wires airglow.* on the daemon origin, so the page renders for real and
        // eval/html/shot reach it directly (no --frame, no cross-origin iframe).
        const appId = String(flags.app);
        args.url = `http://127.0.0.1:${daemon.port}/api/apps/${encodeURIComponent(appId)}/ui?app=${encodeURIComponent(appId)}`;
      } else if (positional[0]) {
        args.url = positional[0];
      } else {
        fail('usage: airglow browser open <url> | --app <id> [--background]');
      }
      args.active = !flags.background;
      break;
    case 'nav':
      if (tab === undefined || !positional[0]) fail('usage: airglow browser nav --tab N <url>');
      args.tabId = tab;
      args.url = positional[0];
      break;
    case 'eval':
      if (tab === undefined || !positional[0]) fail("usage: airglow browser eval --tab N '<js>' [--main] [--app ID] [--timeout MS]");
      args.tabId = tab;
      args.code = positional[0];
      if (flags.main) args.main = true;
      if (flags.frame) args.frame = flags.frame;
      if (flags.app) args.app = flags.app;
      if (flags.timeout !== undefined) args.timeout = Number(flags.timeout);
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
      if (cmd === 'shot' && flags.timeout !== undefined) args.timeout = Number(flags.timeout);
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

// The session id ties every command to one agent's own window. Resolution order:
//   1. AIRGLOW_SESSION — the host's sidepanel agent injects it; any harness can
//      set it to opt in explicitly.
//   2. A known agent harness's own session id — these are auto-exported into the
//      harness's tool subprocesses, so their agents get per-session windows with
//      zero config. Verified present: CLAUDE_CODE_SESSION_ID (Claude Code),
//      HERMES_SESSION_ID (Hermes), OPENCODE_SESSION_ID (OpenCode), CODEX_THREAD_ID
//      (Codex — a "thread" is its session; openai/codex#10096).
//   3. Controlling TTY — a human or a TTY-backed harness shares one window per
//      terminal (a session resumed in the same terminal reuses it).
// None of these (piped/headless, no env) → null → the shared find-or-create window.
function agentSessionId(): string | null {
  if (process.env.AIRGLOW_SESSION) return process.env.AIRGLOW_SESSION;
  const harnesses: [string, string][] = [
    ['HERMES_SESSION_ID', 'hermes'],
    ['CLAUDE_CODE_SESSION_ID', 'cc'],
    ['OPENCODE_SESSION_ID', 'opencode'],
    ['CODEX_THREAD_ID', 'codex'],
  ];
  for (const [name, prefix] of harnesses) {
    const v = process.env[name];
    if (v) return `${prefix}-${v}`;
  }
  return ttySessionId();
}

// The controlling terminal, as a stable per-terminal session key. Inherited by
// every shell a terminal agent spawns (even when their stdio are pipes), so all
// of one agent's `airglow browser` calls map to the same id → the same window.
// `ps -o tty=` reports the controlling tty regardless of fd redirection; `??`
// (no controlling terminal) or any failure → null (anonymous, shared window).
function ttySessionId(): string | null {
  try {
    const out = Bun.spawnSync(['ps', '-o', 'tty=', '-p', String(process.pid)]).stdout.toString().trim();
    if (!out || out === '??' || out === '?') return null;
    return `tty-${out.replace(/[^A-Za-z0-9]/g, '-')}`;
  } catch {
    return null;
  }
}
