// Airglow host binary — one executable, three modes:
//
//   (spawned by Chrome)        connector: native-messaging ⇄ daemon bridge.
//                              Chrome passes the NM manifest path and our
//                              chrome-extension:// origin as argv.
//   airglow daemon [...]       the singleton workspace daemon (app server,
//                              browser bridge, agent sessions).
//   airglow browser <cmd>      CLI for driving the user's browser.

import { runConnector } from './connector';
import { runDaemon } from './daemon/index';
import { runBrowserCli } from './cli/browser';
import { runInstall } from './install';
import { runInternalBuild, runInternalRpc } from './internal';
import { HOST_VERSION } from './version';

const argv = process.argv.slice(2);

const HELP = `airglow host v${HOST_VERSION}

Usage:
  airglow install                               register the native messaging host for installed browsers
  airglow daemon [--workspace DIR] [--port N]   run the workspace daemon
  airglow browser <cmd> ...                     drive the running browser (see \`airglow browser help\`)
  airglow toolkit <cmd> ...                     third-party tools: Gmail, Notion, … (see \`airglow toolkit help\`)
  airglow fetch <url> [markdown|text|html]      fetch a URL and print it as readable text
  airglow update                                update this binary to the latest release

When spawned by Chrome (native messaging) this binary runs in connector mode
automatically and bridges the extension to the daemon.
`;

if (argv.some((a) => a.startsWith('chrome-extension://'))) {
  // Chrome native-messaging invocation: args are the manifest path + origin.
  runConnector();
} else if (argv[0] === 'daemon') {
  runDaemon(argv.slice(1));
} else if (argv[0] === 'browser') {
  runBrowserCli(argv.slice(1));
} else if (argv[0] === 'toolkit') {
  const { runToolkitCli } = await import('./cli/toolkit');
  await runToolkitCli(argv.slice(1));
} else if (argv[0] === 'fetch') {
  const { runFetchCli } = await import('./cli/fetch');
  await runFetchCli(argv.slice(1));
} else if (argv[0] === 'install') {
  runInstall(argv.slice(1));
} else if (argv[0] === 'update') {
  const { runUpdateCli } = await import('./daemon/update');
  await runUpdateCli();
} else if (argv[0] === 'internal-build') {
  runInternalBuild();
} else if (argv[0] === 'internal-rpc') {
  runInternalRpc();
} else if (argv[0] === '--version' || argv[0] === '-v') {
  console.log(HOST_VERSION);
} else {
  process.stdout.write(HELP);
  process.exit(argv.length === 0 ? 0 : 1);
}
