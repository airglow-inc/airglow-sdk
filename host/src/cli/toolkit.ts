// `airglow toolkit <cmd>` — third-party tool access (Composio-backed) through
// the daemon's connector service. Used by the sidepanel agent (its connections
// live under the pseudo-app "agent") and by app developers (--app <id> acts in
// that app's connection scope).

import { requireDaemon } from './daemon';

const HELP = `airglow toolkit — discover and call third-party tools (Gmail, Notion, Sheets, …)

Discovery:
  airglow toolkit search <query>                find toolkits (services) by name
  airglow toolkit tools <toolkit> [query]       list a toolkit's tools
  airglow toolkit schema <TOOL_SLUG>            input schema for one tool

Connections (scoped per app; default scope is the agent):
  airglow toolkit connect <toolkit>             print an OAuth URL for the user, wait for approval
  airglow toolkit status <toolkit>              is the toolkit connected?
  airglow toolkit disconnect <toolkit>          remove the connection
  airglow toolkit accounts                      all connected accounts across apps

Execution:
  airglow toolkit exec <TOOL_SLUG>              run a tool; JSON arguments on stdin
  echo '{"query":"from:uber.com"}' | airglow toolkit exec GMAIL_FETCH_EMAILS

Options:
  --app <id>          act in an app's connection scope (default: agent)
  --account <label>   account label for multi-account identities, e.g. an email
                      (default: "default")
  --no-wait           connect: print the OAuth URL and exit without waiting
`;

export async function runToolkitCli(argv: string[]): Promise<void> {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-wait') flags.noWait = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i] ?? '';
    else positional.push(a);
  }
  const [cmd, arg] = positional;

  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(HELP);
    process.exit(cmd ? 0 : 1);
  }

  const daemon = await requireDaemon();
  const base = `http://127.0.0.1:${daemon.port}/api/connectors`;
  const appId = typeof flags.app === 'string' && flags.app ? flags.app : 'agent';
  const account = typeof flags.account === 'string' && flags.account ? flags.account : undefined;

  const get = async (path: string): Promise<any> => {
    const res = await fetch(`${base}/${path}`);
    return res.json();
  };
  const post = async (action: string, body: Record<string, unknown>): Promise<any> => {
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  // Errors come flat from the daemon ({error, code}) or nested from the
  // cloud gateway ({error: {code, message}}).
  const bail = (data: any): void => {
    if (!data?.error) return;
    const nested = typeof data.error === 'object' ? data.error : null;
    const code = nested?.code ?? data.code;
    console.error(`error: ${nested?.message ?? data.error}${code ? ` (${code})` : ''}`);
    if (code === 'CONNECTOR_SIGNIN_REQUIRED' || code === 'AUTH_SESSION_INVALID') {
      console.error('sign in to Airglow from the extension dashboard, then retry.');
    }
    process.exit(1);
  };

  switch (cmd) {
    case 'search': {
      if (!arg) fail('usage: airglow toolkit search <query>');
      const data = await get(`toolkits?search=${encodeURIComponent(arg)}`);
      bail(data);
      if (!data.toolkits?.length) { console.log(`no toolkits found for "${arg}"`); return; }
      for (const tk of data.toolkits) {
        console.log(`${tk.slug} (${tk.tools ?? '?'} tools) — ${tk.name}`);
        if (tk.description) console.log(`  ${tk.description}`);
      }
      return;
    }

    case 'tools': {
      if (!arg) fail('usage: airglow toolkit tools <toolkit> [query]');
      const q = positional[2] ? `&search=${encodeURIComponent(positional[2])}` : '';
      const data = await get(`tools?toolkit=${encodeURIComponent(arg.toLowerCase())}${q}`);
      bail(data);
      console.log(`${arg.toLowerCase()} — ${data.tools.length} tools\n`);
      for (const t of data.tools) {
        console.log(t.slug);
        console.log(`  ${t.description ?? t.name}`);
      }
      return;
    }

    case 'schema': {
      if (!arg) fail('usage: airglow toolkit schema <TOOL_SLUG>');
      const data = await get(`schema?tool=${encodeURIComponent(arg.toUpperCase())}`);
      bail(data);
      const t = data.tool;
      console.log(`${t.slug} (${t.toolkit})\n  ${t.description}\n`);
      printSchema(t.input_parameters);
      return;
    }

    case 'status': {
      if (!arg) fail('usage: airglow toolkit status <toolkit>');
      const data = await post('status', { appId, toolkit: arg.toLowerCase(), account });
      bail(data);
      console.log(data.connected ? 'connected' : 'not connected');
      return;
    }

    case 'disconnect': {
      if (!arg) fail('usage: airglow toolkit disconnect <toolkit>');
      const data = await post('disconnect', { appId, toolkit: arg.toLowerCase(), account });
      bail(data);
      console.log(`removed ${data.removed} connection(s)`);
      return;
    }

    case 'accounts': {
      const data = await get('accounts');
      bail(data);
      if (!data.accounts?.length) { console.log('no connected accounts'); return; }
      for (const a of data.accounts) {
        console.log(`${a.appId}/${a.account} → ${a.toolkit} [${a.status}]`);
      }
      return;
    }

    case 'connect': {
      if (!arg) fail('usage: airglow toolkit connect <toolkit>');
      const data = await post('initiate', { appId, toolkit: arg.toLowerCase(), account });
      bail(data);
      if (data.connected) { console.log('already connected'); return; }
      console.log(`Open this URL to authorize ${arg.toLowerCase()}:\n\n  ${data.authUrl}\n`);
      if (flags.noWait) {
        console.log('(re-run `airglow toolkit status` after approving)');
        return;
      }
      console.log('waiting for approval (up to 3 minutes)…');
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const w = await post('wait', { connectedAccountId: data.connectedAccountId, timeoutMs: 10_000 });
        if (w.connected) { console.log('connected'); return; }
        if (['FAILED', 'EXPIRED', 'REVOKED'].includes(w.status)) {
          console.error(`connection ${String(w.status).toLowerCase()}`);
          process.exit(1);
        }
      }
      console.error('timed out waiting for approval — re-run `airglow toolkit status` after approving');
      process.exit(1);
    }

    case 'exec': {
      if (!arg) fail('usage: echo \'{"k":"v"}\' | airglow toolkit exec <TOOL_SLUG>');
      let args: Record<string, unknown> = {};
      const stdinText = process.stdin.isTTY ? '' : (await new Response(Bun.stdin.stream()).text()).trim();
      if (stdinText) {
        try { args = JSON.parse(stdinText); }
        catch { fail(`stdin is not valid JSON: ${stdinText.slice(0, 120)}`); }
      }
      const data = await post('execute', { appId, tool: arg.toUpperCase(), arguments: args, account });
      bail(data);
      console.log(JSON.stringify(data, null, 2));
      if (data.successful === false) process.exit(1);
      return;
    }

    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

function printSchema(schema: any): void {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  if (!Object.keys(props).length) { console.log('(no input parameters)'); return; }
  console.log('Parameters:');
  for (const [name, def] of Object.entries(props) as [string, any][]) {
    const type = def.type || def.anyOf?.map((a: any) => a.type).join('|') || '?';
    const en = def.enum ? ` [${def.enum.join(', ')}]` : '';
    console.log(`  ${name}: ${type}${required.has(name) ? ' (required)' : ''}${en}`);
    if (def.description) console.log(`    ${def.description}`);
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
