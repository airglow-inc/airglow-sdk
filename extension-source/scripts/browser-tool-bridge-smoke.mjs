#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_EXTENSION_DIR = resolve(new URL('../..', import.meta.url).pathname, 'extension');
const RESPONSE_TIMEOUT_MS = 15000;
const TOOL_RESULT_TIMEOUT_MS = 25000;
const UNIQUE_TARGET_TEXT = 'Unique browser tool bridge smoke content 9917.';
const KNOWN_CLOUD_SOURCE_URLS = [
  'http://127.0.0.1:3002',
  'https://api.airglow.dev',
  'https://mvp-api.airglow.dev',
];

function parseArgs(argv) {
  const args = {
    extensionDir: process.env.AIRGLOW_EXTENSION_SMOKE_EXTENSION_DIR || DEFAULT_EXTENSION_DIR,
    keepChrome: process.env.AIRGLOW_EXTENSION_SMOKE_KEEP_CHROME === '1',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--extension') {
      args.extensionDir = requiredArg(argv, index += 1, arg);
    } else if (arg === '--keep-chrome') {
      args.keepChrome = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function requiredArg(argv, index, name) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function printUsage() {
  console.log(`Usage: pnpm smoke:browser-tools [-- --extension <dir>] [-- --keep-chrome]

Launches a separate Chrome profile, loads a temporary copy of the built
Airglow extension, points it at an in-process mock cloud source, and verifies:
  browser tool queue claim -> active tab metadata -> active page text capture
  -> browser tool result callback.

The script opens a separate Chrome instance. Ask before running it in an
interactive session.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Airglow-User-Id, X-Airglow-User-Email',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, contentType = 'text/html; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Airglow-User-Id, X-Airglow-User-Email',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function startTargetSite() {
  const server = createServer((_req, res) => {
    text(res, 200, `<!doctype html>
<html>
  <head><title>Airglow Browser Tool Smoke Target</title></head>
  <body>
    <main>
      <h1>Airglow Browser Tool Smoke Target</h1>
      <p>${UNIQUE_TARGET_TEXT}</p>
      <p>This page must be read by the extension browser tool bridge.</p>
    </main>
  </body>
</html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    targetUrl: `${baseUrl}/browser-tool-bridge-smoke`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startMockCloud() {
  const requests = [];
  const calls = new Map();
  const results = new Map();
  const session = {
    accessToken: 'mock-browser-tool-access-token',
    refreshToken: 'mock-browser-tool-refresh-token',
    userId: 'supabase:browser-tool-smoke-owner',
    userEmail: 'browser-tool-smoke@airglow.local',
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const authorized = authorization === `Bearer ${session.accessToken}`;
      requests.push({ method: req.method, path: url.pathname, authorized });
      if (req.method === 'OPTIONS') {
        text(res, 204, '', 'text/plain');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/identity/session') {
        json(res, 200, { ok: true, ...session });
        return;
      }

      if (!authorized) {
        json(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Mock cloud expected bearer session.' } });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/browser-tools/calls/claim') {
        await readJsonBody(req);
        const claimable = Array.from(calls.values())
          .filter((call) => call.status === 'queued')
          .slice(0, 3)
          .map((call) => {
            call.status = 'claimed';
            call.claimedAt = new Date().toISOString();
            return call;
          });
        json(res, 200, { ok: true, calls: claimable });
        return;
      }

      const resultMatch = /^\/api\/browser-tools\/calls\/([^/]+)\/result$/.exec(url.pathname);
      if (req.method === 'POST' && resultMatch) {
        const callId = decodeURIComponent(resultMatch[1]);
        const call = calls.get(callId);
        if (!call) {
          json(res, 404, { ok: false, error: { code: 'CALL_NOT_FOUND', message: 'Tool call not found.' } });
          return;
        }
        const body = await readJsonBody(req);
        call.status = body.error ? 'failed' : 'completed';
        call.completedAt = new Date().toISOString();
        results.set(callId, { call, body });
        json(res, 200, { ok: true, call: { ...call, result: body.result, error: body.error } });
        return;
      }

      const readMatch = /^\/api\/browser-tools\/calls\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && readMatch) {
        const callId = decodeURIComponent(readMatch[1]);
        const call = calls.get(callId);
        if (!call) {
          json(res, 404, { ok: false, error: { code: 'CALL_NOT_FOUND', message: 'Tool call not found.' } });
          return;
        }
        const result = results.get(callId)?.body;
        json(res, 200, { ok: true, call: { ...call, result: result?.result, error: result?.error } });
        return;
      }

      json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (error) {
      json(res, 500, {
        ok: false,
        error: { code: 'MOCK_CLOUD_FAILED', message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    requests,
    enqueue(call) {
      calls.set(call.callId, {
        status: 'queued',
        createdAt: new Date().toISOString(),
        ...call,
      });
    },
    result(callId) {
      return results.get(callId);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function patchExtensionForCloudSource(sourceDir, cloudUrl) {
  const tempDir = await mkdtemp(join(tmpdir(), 'airglow-browser-tool-smoke-extension-'));
  const extensionDir = join(tempDir, 'extension');
  await cp(sourceDir, extensionDir, { recursive: true });
  await patchJsFiles(extensionDir, cloudUrl);
  return {
    extensionDir,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

async function patchJsFiles(root, cloudUrl) {
  const entries = await import('node:fs/promises').then((fs) => fs.readdir(root, { withFileTypes: true }));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await patchJsFiles(path, cloudUrl);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const current = await readFile(path, 'utf8');
    let next = current;
    for (const sourceUrl of KNOWN_CLOUD_SOURCE_URLS) {
      next = next.replaceAll(sourceUrl, cloudUrl);
    }
    if (next !== current) await writeFile(path, next);
  }
}

function launchChrome(userDataDir) {
  assert(existsSync(CHROME_BIN), `Chrome binary not found: ${CHROME_BIN}`);
  return spawn(CHROME_BIN, [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-component-extensions-with-background-pages',
    '--disable-features=Translate,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,PrivacySandboxSettings4',
    '--hide-crash-restore-bubble',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

function createCdp(chrome) {
  const pipeOut = chrome.stdio[3];
  const pipeIn = chrome.stdio[4];
  let id = 0;
  let received = '';
  const pending = new Map();
  pipeIn.on('data', (chunk) => {
    received += chunk;
    let end = received.indexOf('\0');
    while (end !== -1) {
      const raw = received.slice(0, end);
      received = received.slice(end + 1);
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject, timeout } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timeout);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result || {});
      }
      end = received.indexOf('\0');
    }
  });

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const callId = ++id;
      const timeout = setTimeout(() => {
        pending.delete(callId);
        reject(new Error(`CDP ${method} timed out`));
      }, RESPONSE_TIMEOUT_MS);
      pending.set(callId, { resolve, reject, timeout });
      const message = { id: callId, method, params };
      if (sessionId) message.sessionId = sessionId;
      pipeOut.write(`${JSON.stringify(message)}\0`);
    });
  }

  return { send };
}

async function waitForTarget(cdp, predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find(predicate);
    if (target) return target;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});
  return sessionId;
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function waitForExpression(cdp, sessionId, expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, sessionId, expression).catch((error) => ({ error: error.message }));
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function waitForDocumentReady(cdp, sessionId) {
  await waitForExpression(
    cdp,
    sessionId,
    `document.readyState === 'complete' || document.readyState === 'interactive'`,
    'document ready',
  );
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const sessionId = await attach(cdp, targetId);
  await waitForDocumentReady(cdp, sessionId);
  await cdp.send('Target.activateTarget', { targetId });
  return { targetId, sessionId, url };
}

async function waitForToolResult(mockCloud, callId) {
  const deadline = Date.now() + TOOL_RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = mockCloud.result(callId);
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for browser tool result ${callId}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetSite = await startTargetSite();
  const mockCloud = await startMockCloud();
  const patched = await patchExtensionForCloudSource(resolve(args.extensionDir), mockCloud.baseUrl);
  const profileDir = await mkdtemp(join(tmpdir(), 'airglow-browser-tool-smoke-profile-'));
  const chrome = launchChrome(profileDir);
  const stderr = [];
  chrome.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const cdp = createCdp(chrome);

  try {
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: patched.extensionDir });
    const extensionId = loaded.id;
    await waitForTarget(
      cdp,
      (target) => target.type === 'service_worker' && target.url.includes(extensionId),
      'extension service worker',
    );

    const targetPage = await openPage(cdp, targetSite.targetUrl);
    const pageText = await evaluate(cdp, targetPage.sessionId, 'document.body.innerText');
    assert(String(pageText).includes(UNIQUE_TARGET_TEXT), 'target page did not load expected text');

    mockCloud.enqueue({
      callId: 'current-tab-smoke',
      toolName: 'browser.current_tab',
      input: {},
    });
    mockCloud.enqueue({
      callId: 'read-page-smoke',
      toolName: 'browser.read_page',
      input: { maxChars: 12000 },
    });

    const currentTabResult = await waitForToolResult(mockCloud, 'current-tab-smoke');
    const readPageResult = await waitForToolResult(mockCloud, 'read-page-smoke');

    assert(!currentTabResult.body.error, `current tab tool failed: ${JSON.stringify(currentTabResult.body.error)}`);
    assert(!readPageResult.body.error, `read page tool failed: ${JSON.stringify(readPageResult.body.error)}`);

    const currentTab = currentTabResult.body.result?.tab || {};
    assert(currentTab.title === 'Airglow Browser Tool Smoke Target', `unexpected active tab title: ${JSON.stringify(currentTab)}`);
    assert(currentTab.url === targetSite.targetUrl, `unexpected active tab url: ${JSON.stringify(currentTab)}`);

    const readPage = readPageResult.body.result?.page || {};
    assert(readPage.title === 'Airglow Browser Tool Smoke Target', `unexpected page title: ${JSON.stringify(readPage)}`);
    assert(readPage.url === targetSite.targetUrl, `unexpected page url: ${JSON.stringify(readPage)}`);
    assert(String(readPage.text || '').includes(UNIQUE_TARGET_TEXT), 'read page result did not include target page text');

    console.log(JSON.stringify({
      ok: true,
      extensionId,
      mockCloud: mockCloud.baseUrl,
      targetUrl: targetSite.targetUrl,
      requests: mockCloud.requests.map((request) => ({
        method: request.method,
        path: request.path,
        authorized: request.authorized,
      })),
      checks: [
        'extension-loaded',
        'mock-cloud-session-created',
        'browser-tool-calls-claimed',
        'active-tab-returned',
        'active-page-text-returned',
        'tool-results-posted',
      ],
    }, null, 2));
  } finally {
    if (!args.keepChrome) {
      await cdp.send('Browser.close').catch(() => chrome.kill());
      await new Promise((resolve) => chrome.once('exit', resolve));
      await rm(profileDir, { recursive: true, force: true });
    } else {
      console.error(`Chrome left running with profile: ${profileDir}`);
    }
    await patched.cleanup();
    await mockCloud.close();
    await targetSite.close();
    if (!args.keepChrome && chrome.exitCode === null) chrome.kill();
    if (stderr.some((line) => line.includes('Failed to load extension'))) {
      console.error(stderr.join(''));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
