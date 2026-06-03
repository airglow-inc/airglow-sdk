#!/usr/bin/env node
/**
 * Read and modify a debug browser's DOM through the Airglow trace host — no CDP.
 *
 * The trace host (the extension's native-messaging bridge) runs an HTTP server;
 * this script talks to it and the extension performs the DOM work via
 * chrome.scripting. Port is resolved automatically from ~/.airglow/hosts/ (see
 * docs/browser-debugging.md), or pass --port N.
 *
 * Usage:
 *   pnpm dom port                                  resolved trace-host port
 *   pnpm dom tabs                                  list open tabs
 *   pnpm dom frames --tab N                        list a tab's frames (frameId, url)
 *   pnpm dom html  --tab N [--selector CSS]        outerHTML (default: whole doc)
 *   pnpm dom eval  --tab N 'document.title'        run arbitrary JS (CSP-exempt world)
 *   pnpm dom eval  --tab N --main 'window.__test.go()'  run in page MAIN world (sees
 *                                                  page/app globals; page CSP applies)
 *   pnpm dom set   --tab N --selector '#x' '<b>hi</b>'   set innerHTML (--outer for outerHTML)
 *   pnpm dom open|nav|reload|close ...             tab control (see usage line at bottom)
 *   pnpm dom shot  --tab N [--out f.png]           screenshot the tab
 *
 * Tab selection: every tab-targeted command (frames/html/eval/set/nav/reload/
 * close/shot) requires --tab N. Get the id from `pnpm dom tabs`. Auto-picking was
 * removed deliberately — when the agent doesn't have a tab id in its working state,
 * it gets confused about which tab it's driving.
 *
 * Frame targeting: html/eval/set default to the top document. Pass
 * --frame <url-substr> to run inside a child frame instead — e.g. an app UI runs
 * in an app-shell iframe served from the dev server, so target it with
 * `--frame 127.0.0.1:3222` (use `pnpm dom frames --tab N` to see frame URLs).
 *
 * Port selection (resolvePort), in order — picks from the registry's live
 * records (~/.airglow/hosts/, dead pids already pruned); it does NOT probe each
 * port, so the chosen one's reachability surfaces on the first request:
 *   1. --port N                                      explicit, wins outright
 *   2. the host whose browser profile (userDataDir) is under THIS workspace's
 *      .airglow/ — i.e. the browser you launched here with `pnpm chrome`
 *   3. the host on the default port (3277)
 *   4. the sole registered host, if there's exactly one
 *   5. two-plus hosts and none match the above → error, list, ask for --port
 *   6. no hosts registered → fall back to 3277 (may be down)
 */
import { readHostRecords } from '../../cli/lib/native-host/registry.mjs';
import { resolve } from 'node:path';

const DEFAULT_PORT = 3277;

const BOOL_FLAGS = new Set(['outer', 'background', 'main']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq !== -1 ? a.slice(2, eq) : a.slice(2);
      if (eq !== -1) flags[name] = a.slice(eq + 1);
      // Known boolean flags never consume the next token (which may be eval code).
      else if (BOOL_FLAGS.has(name)) flags[name] = true;
      // Otherwise: value flag, unless the next token is another flag or absent.
      else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[name] = true;
      else flags[name] = argv[++i];
    } else positional.push(a);
  }
  return { flags, positional };
}

function fail(msg, code = 1) { console.error(msg); process.exit(code); }

function resolvePort(flags) {
  if (flags.port) return Number(flags.port);
  const recs = readHostRecords().filter((r) => r.service === 'airglow-trace');
  if (!recs.length) return DEFAULT_PORT; // nothing registered; try the default anyway
  // Prefer the host whose browser profile lives under this workspace's .airglow.
  const cwdProfile = resolve(process.cwd(), '.airglow');
  const mine = recs.find((r) => r.userDataDir && r.userDataDir.startsWith(cwdProfile));
  if (mine) return mine.port;
  const onDefault = recs.find((r) => r.default);
  if (onDefault) return onDefault.port;
  if (recs.length === 1) return recs[0].port;
  fail('Multiple trace hosts running — pass --port. Candidates:\n' +
    recs.map((r) => `  :${r.port}  ${r.userDataDir || '(unknown profile)'}`).join('\n'), 2);
}

async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => fail(`trace host unreachable at ${base} (${e.code || e.message}). Is the debug browser running?`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`error: ${data.error || res.status}`);
  return data;
}

async function resolveTab(base, flags) {
  if (flags.tab) return Number(flags.tab);
  const { tabs } = await api(base, 'GET', '/tabs');
  fail('--tab N is required. Open tabs:\n' +
    tabs.map((t) => `  ${String(t.id).padStart(6)}  ${t.active ? '*' : ' '} ${t.url}`).join('\n'));
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const cmd = positional.shift();
const base = `http://127.0.0.1:${resolvePort(flags)}`;

switch (cmd) {
  case 'port':
    console.log(base.replace('http://127.0.0.1:', ''));
    break;
  case 'tabs': {
    const { tabs } = await api(base, 'GET', '/tabs');
    for (const t of tabs) console.log(`${String(t.id).padStart(6)}  ${t.active ? '*' : ' '} ${t.url}`);
    break;
  }
  case 'frames': {
    const tabId = await resolveTab(base, flags);
    const { frames } = await api(base, 'GET', `/frames?tabId=${tabId}`);
    for (const f of frames) console.log(`${String(f.frameId).padStart(4)}  ${f.url}`);
    break;
  }
  case 'html': {
    const tabId = await resolveTab(base, flags);
    const q = new URLSearchParams({ tabId: String(tabId) });
    if (flags.selector) q.set('selector', flags.selector);
    if (flags.frame) q.set('frame', flags.frame);
    const { html } = await api(base, 'GET', `/html?${q}`);
    process.stdout.write(html ?? '');
    process.stdout.write('\n');
    break;
  }
  case 'eval': {
    const code = positional.join(' ');
    if (!code) fail("provide code: pnpm dom eval --tab N 'document.title'");
    const tabId = await resolveTab(base, flags);
    const r = await api(base, 'POST', '/eval', { tabId, code, frame: flags.frame, main: !!flags.main });
    console.log(JSON.stringify(r.value, null, 2));
    break;
  }
  case 'set': {
    const html = positional.join(' ');
    if (html === '') fail("provide markup: pnpm dom set --tab N --selector '#x' '<b>hi</b>'");
    const tabId = await resolveTab(base, flags);
    await api(base, 'POST', '/sethtml', { tabId, selector: flags.selector ?? null, html, outer: !!flags.outer, frame: flags.frame });
    console.log('ok');
    break;
  }
  case 'open': {
    const url = positional[0];
    if (!url) fail('provide a URL: pnpm dom open https://example.com [--background]');
    const r = await api(base, 'POST', '/open', { url, active: !flags.background });
    console.log(`opened tab ${r.id}`);
    break;
  }
  case 'nav': {
    const url = positional[0];
    if (!url) fail('provide a URL: pnpm dom nav --tab N https://example.com');
    const tabId = await resolveTab(base, flags);
    await api(base, 'POST', '/navigate', { tabId, url });
    console.log('ok');
    break;
  }
  case 'reload': {
    const tabId = await resolveTab(base, flags);
    await api(base, 'POST', '/reloadtab', { tabId });
    console.log('ok');
    break;
  }
  case 'close': {
    const tabId = await resolveTab(base, flags);
    await api(base, 'POST', '/close', { tabId });
    console.log('ok');
    break;
  }
  case 'shot': {
    const tabId = await resolveTab(base, flags);
    const { dataUrl } = await api(base, 'POST', '/capture', { tabId });
    const out = flags.out || `dom-shot-${tabId}.jpg`;
    const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
    (await import('node:fs')).writeFileSync(out, Buffer.from(b64, 'base64'));
    console.log(`wrote ${out}`);
    break;
  }
  default:
    fail('Usage: pnpm dom <port|tabs|frames|html|eval|set|shot|open|nav|reload|close> --tab N [--frame URLSUBSTR] [--main] [--selector CSS] [--outer] [--background] [--out file] [--port N]');
}
