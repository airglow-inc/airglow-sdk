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
  console.log(`Usage: pnpm smoke:sidepanel-mvp [-- --extension <dir>] [-- --keep-chrome]

Launches a separate Chrome profile, loads a temporary copy of the built
Airglow extension, points it at an in-process mock cloud source, and verifies:
  sidepanel save background flow -> registered private app -> app-shell opens
  -> target page userscript injects DOM -> dashboard My Apps contains the saved
  private app.

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

function text(res, status, body, contentType = 'text/javascript; charset=utf-8') {
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
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(`<!doctype html>
<html>
  <head><title>Airglow Browser Smoke Target</title></head>
  <body>
    <main>
      <h1>Airglow Browser Smoke Target</h1>
      <p>This page verifies generated app page injection.</p>
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
    targetUrl: `${baseUrl}/airglow-browser-smoke`,
    matchPattern: `${baseUrl}/*`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startMockCloud(targetSite) {
  let saved = null;
  const requests = [];
  const session = {
    accessToken: 'mock-access-owner',
    refreshToken: 'mock-refresh-owner',
    userId: 'supabase:browser-smoke-owner',
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const userId = authorization === `Bearer ${session.accessToken}` ? session.userId : '';
      requests.push({ method: req.method, path: url.pathname, userId, authorization });
      if (req.method === 'OPTIONS') {
        text(res, 204, '', 'text/plain');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/identity/session') {
        json(res, 200, { ok: true, ...session });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/apps/manifests') {
        json(res, 200, saved && userId === saved.ownerUserId ? [saved.manifest] : []);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/apps/private/save') {
        const body = await readJsonBody(req);
        assert(typeof userId === 'string' && userId.trim(), 'missing bearer identity');
        const appId = 'private-browser-smoke';
        const manifest = {
          id: appId,
          slug: appId,
          name: body.name || 'Private Browser Smoke',
          version: '1.0.0-browser-smoke',
          description: body.prompt || 'Browser smoke app',
          visibility: 'private',
          tags: ['private', 'sidepanel', 'smoke'],
          details: {
            summary: 'Browser smoke private app',
            longDescription: ['Created by sidepanel MVP smoke.'],
          },
          userscripts: [{
            file: 'userscripts/context.js',
            matches: [targetSite.matchPattern],
            runAt: 'document_idle',
          }],
          host_permissions: [targetSite.matchPattern],
          ui: { entry: 'ui/App.js' },
        };
        saved = {
          ownerUserId: userId,
          manifest,
          payload: body,
        };
        json(res, 200, {
          ok: true,
          appId,
          appKey: appId,
          versionKey: `${appId}@${manifest.version}`,
          manifest,
        });
        return;
      }

      const appMatch = /^\/api\/apps\/([^/]+)\/(ui-bundle|userscript|source)$/.exec(url.pathname);
      if (appMatch) {
        const [, appId, kind] = appMatch;
        if (!saved || appId !== saved.manifest.id || userId !== saved.ownerUserId) {
          json(res, 404, { ok: false, error: { code: 'APP_NOT_FOUND', message: 'App not found' } });
          return;
        }
        if (kind === 'ui-bundle') {
          text(res, 200, `
            document.getElementById('root').innerHTML =
              '<main data-testid="airglow-browser-smoke-app"><h1>Browser smoke app loaded</h1><p>${saved.manifest.id}</p></main>';
            window.__airglowBrowserSmokeLoaded = true;
          `);
          return;
        }
        if (kind === 'userscript') {
          text(res, 200, `
            const marker = document.createElement('div');
            marker.id = 'airglow-browser-smoke-page-panel';
            marker.setAttribute('data-testid', 'airglow-browser-smoke-page-panel');
            marker.textContent = 'Airglow browser smoke page panel injected';
            marker.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#fff;border:1px solid #111;padding:8px;';
            document.body.appendChild(marker);
            airglow.storage.set('latestPageContext', {
              title: document.title,
              url: location.href,
              text: document.body ? document.body.innerText.slice(0, 256) : ''
            });
          `);
          return;
        }
        json(res, 200, {
          schemaVersion: 1,
          appId,
          name: saved.manifest.name,
          version: saved.manifest.version,
          fileCount: 3,
          totalBytes: 128,
          files: [
            { path: 'manifest.json', contentBase64: Buffer.from(JSON.stringify(saved.manifest)).toString('base64') },
            { path: 'ui/App.js', contentBase64: Buffer.from('export default function App() {}').toString('base64') },
            { path: 'userscripts/context.js', contentBase64: Buffer.from('airglow.storage.set("latestPageContext", {});').toString('base64') },
          ],
        });
        return;
      }

      json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (error) {
      json(res, 500, { ok: false, error: { code: 'MOCK_CLOUD_FAILED', message: error instanceof Error ? error.message : String(error) } });
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
    get saved() { return saved; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function patchExtensionForCloudSource(sourceDir, cloudUrl) {
  const tempDir = await mkdtemp(join(tmpdir(), 'airglow-extension-smoke-'));
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

function launchChrome(extensionDir, userDataDir) {
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

async function evaluate(cdp, sessionId, expression, contextId) {
  const params = {
    expression,
    awaitPromise: true,
    returnByValue: true,
  };
  if (contextId) params.contextId = contextId;
  const result = await cdp.send('Runtime.evaluate', params, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function waitForExpression(cdp, sessionId, expression, label, timeoutMs = 10000, contextId) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, sessionId, expression, contextId).catch((error) => ({ error: error.message }));
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

async function waitForFirstChildFrame(cdp, sessionId, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastFrameTree = null;
  while (Date.now() < deadline) {
    const frameTree = await cdp.send('Page.getFrameTree', {}, sessionId);
    lastFrameTree = frameTree.frameTree;
    const childFrame = frameTree.frameTree.childFrames?.[0]?.frame;
    if (childFrame?.id) return childFrame;
    await sleep(100);
  }
  const diagnostics = await evaluate(cdp, sessionId, `({
    readyState: document.readyState,
    hasIframe: Boolean(document.querySelector('iframe')),
    iframeSrc: document.querySelector('iframe')?.src || '',
    loadingText: document.getElementById('loading')?.textContent || '',
    crashText: document.getElementById('airglow-app-crash')?.textContent || '',
    bodyText: document.body?.innerText?.slice(0, 500) || ''
  })`).catch((error) => ({ error: error.message }));
  throw new Error(`Timed out waiting for ${label}; diagnostics=${JSON.stringify(diagnostics)}; frameTree=${JSON.stringify(lastFrameTree)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const findUserScriptsToggleExpression = `(() => {
  const seen = new Set();
  const nodes = [];
  const visit = (root) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    const all = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
    for (const node of all) {
      nodes.push(node);
      if (node.shadowRoot) visit(node.shadowRoot);
    }
  };
  visit(document);
  const parentOf = (node) => node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
  const describe = (node) => [
    node.id,
    node.getAttribute && node.getAttribute('aria-label'),
    node.getAttribute && node.getAttribute('label'),
    node.textContent,
  ].filter(Boolean).join(' ');
  const contextText = (node) => {
    const parts = [];
    let current = node;
    for (let depth = 0; current && depth < 4; depth += 1) {
      parts.push(describe(current));
      current = parentOf(current);
    }
    return parts.join(' ');
  };
  const toggles = nodes.filter((node) =>
    node.matches && node.matches('cr-toggle, extensions-toggle-row')
  );
  let toggle = toggles.find((node) =>
    node.id !== 'enableToggle'
    && (/user\\s*scripts?/i.test(node.id || '') || /user\\s*scripts?/i.test(contextText(node)))
  );
  if (!toggle) {
    const row = nodes.find((node) => /user\\s*scripts?/i.test(describe(node)));
    toggle = row?.querySelector && row.querySelector('cr-toggle, extensions-toggle-row');
  }
  if (!toggle) {
    return {
      ok: false,
      error: 'Allow User Scripts toggle not found',
      toggles: toggles.slice(0, 12).map((node) => ({
        tag: node.tagName,
        id: node.id || null,
        context: contextText(node).replace(/\\s+/g, ' ').slice(0, 180),
      })),
    };
  }
  const clickTarget = (toggle.shadowRoot && toggle.shadowRoot.querySelector('cr-toggle'))
    || (toggle.querySelector && toggle.querySelector('cr-toggle'))
    || toggle;
  const isChecked = () => toggle.checked === true
    || clickTarget.checked === true
    || toggle.getAttribute('aria-pressed') === 'true'
    || toggle.getAttribute('aria-checked') === 'true'
    || clickTarget.getAttribute('aria-pressed') === 'true'
    || clickTarget.getAttribute('aria-checked') === 'true';
  const before = isChecked();
  clickTarget.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = clickTarget.getBoundingClientRect();
  return {
    ok: true,
    before,
    after: before,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
})()`;

function sidepanelDraft(now, targetUrl) {
  return {
    id: 'draft-browser-smoke',
    name: 'Browser Smoke App',
    prompt: 'Summarize the current page context for the Airglow browser smoke.',
    target: {
      id: 1,
      windowId: 1,
      title: 'Example Domain',
      url: targetUrl,
      status: 'complete',
    },
    requestedActions: ['read_current_tab_metadata', 'capture_semantic_fingerprint', 'dom_query'],
    review: {
      readOnly: [
        { action: 'read_current_tab_metadata', level: 'allowed', label: 'Read selected tab metadata.' },
        { action: 'capture_semantic_fingerprint', level: 'allowed', label: 'Read visible page structure.' },
        { action: 'dom_query', level: 'allowed', label: 'Read matching elements.' },
      ],
      disclosures: [],
      approvals: [],
    },
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

async function sendSidepanelSave(cdp, sessionId, targetUrl) {
  const now = new Date().toISOString();
  const message = {
    type: 'airglow:sidepanel:save-draft',
    requestId: 'browser-smoke-request',
    draft: sidepanelDraft(now, targetUrl),
  };
  return await evaluate(cdp, sessionId, `
    new Promise((resolve) => {
      chrome.runtime.sendMessage(${JSON.stringify(message)}, (response) => {
        resolve(chrome.runtime.lastError
          ? { error: chrome.runtime.lastError.message }
          : response);
      });
    })
  `);
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const sessionId = await attach(cdp, targetId);
  await waitForDocumentReady(cdp, sessionId);
  return { targetId, sessionId, url };
}

async function openExtensionPage(cdp, extensionId, path) {
  return await openPage(cdp, `chrome-extension://${extensionId}/${path}`);
}

async function closeTarget(cdp, targetId) {
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
}

async function verifyUserScripts(cdp, extensionId) {
  const page = await openExtensionPage(cdp, extensionId, 'startup-runner.html?airglowSetup=1');
  try {
    return await evaluate(cdp, page.sessionId, `
      chrome.userScripts
        ? chrome.userScripts.getScripts()
          .then((scripts) => ({ enabled: true, scriptCount: scripts.length }))
          .catch((error) => ({ enabled: false, error: String(error && error.message || error) }))
        : Promise.resolve({ enabled: false, error: 'chrome.userScripts unavailable' })
    `);
  } finally {
    await closeTarget(cdp, page.targetId);
  }
}

async function enableUserScriptsViaWebUi(cdp, extensionId) {
  const page = await openPage(cdp, `chrome://extensions/?id=${extensionId}`);
  try {
    await sleep(1500);
    const before = await evaluate(cdp, page.sessionId, findUserScriptsToggleExpression);
    if (!before?.ok) return before;
    if (before.before) return { ...before, clicked: false, after: true };

    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y }, page.sessionId);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: before.x,
      y: before.y,
      button: 'left',
      clickCount: 1,
    }, page.sessionId);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: before.x,
      y: before.y,
      button: 'left',
      clickCount: 1,
    }, page.sessionId);

    await sleep(1000);
    const after = await evaluate(cdp, page.sessionId, findUserScriptsToggleExpression).catch(() => null);
    return { ...before, clicked: true, after: after?.before ?? after?.after ?? false };
  } finally {
    await closeTarget(cdp, page.targetId);
  }
}

async function ensureUserScriptsEnabled(cdp, extensionId) {
  let status = await verifyUserScripts(cdp, extensionId);
  if (status?.enabled) return status;
  const webUi = await enableUserScriptsViaWebUi(cdp, extensionId);
  status = await verifyUserScripts(cdp, extensionId);
  if (!status?.enabled) {
    throw new Error(`User Scripts are not enabled after WebUI attempt: ${JSON.stringify({ webUi, status })}`);
  }
  return { ...status, webUi };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetSite = await startTargetSite();
  const mockCloud = await startMockCloud(targetSite);
  const patched = await patchExtensionForCloudSource(resolve(args.extensionDir), mockCloud.baseUrl);
  const profileDir = await mkdtemp(join(tmpdir(), 'airglow-chrome-smoke-profile-'));
  const chrome = launchChrome(patched.extensionDir, profileDir);
  const stderr = [];
  chrome.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const cdp = createCdp(chrome);
  let extensionId = '';

  try {
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: patched.extensionDir });
    extensionId = loaded.id;
    const serviceWorker = await waitForTarget(
      cdp,
      (target) => target.type === 'service_worker' && target.url.includes(extensionId),
      'extension service worker',
    );
    const serviceWorkerSession = await attach(cdp, serviceWorker.targetId);
    await evaluate(cdp, serviceWorkerSession, `
      chrome.storage.local.set({
        __airglow_user_id: 'browser-smoke-owner',
        __airglow_user_email: 'browser-smoke@airglow.local',
        __airglow_skip_dev_seed: true
      })
    `);
    const userScripts = await ensureUserScriptsEnabled(cdp, extensionId);

    const sidepanel = await openExtensionPage(cdp, extensionId, 'sidepanel.html');
    const saveResponse = await sendSidepanelSave(cdp, sidepanel.sessionId, targetSite.targetUrl);
    assert(saveResponse?.ok === true, `save response failed: ${JSON.stringify(saveResponse)}`);
    assert(saveResponse.mode === 'cloud', `save did not use cloud mode: ${JSON.stringify(saveResponse)}`);
    assert(saveResponse.cloud?.appId === 'private-browser-smoke', 'unexpected saved app id');
    assert(saveResponse.cloud?.registered === true, `saved app was not registered: ${JSON.stringify(saveResponse.cloud)}`);
    assert(saveResponse.cloud?.userScriptsEnabled === true, `user scripts were not enabled: ${JSON.stringify(saveResponse.cloud)}`);

    const targetPage = await openPage(cdp, targetSite.targetUrl);
    await waitForExpression(
      cdp,
      targetPage.sessionId,
      `Boolean(document.getElementById('airglow-browser-smoke-page-panel'))`,
      'page userscript panel injection',
      10000,
    );

    const appShell = await openExtensionPage(cdp, extensionId, 'app-shell.html?app=private-browser-smoke');
    await waitForExpression(
      cdp,
      appShell.sessionId,
      `document.querySelector('iframe') && !document.getElementById('loading') && !document.getElementById('airglow-app-crash')`,
      'app shell iframe without crash',
    );
    await waitForExpression(
      cdp,
      appShell.sessionId,
      `document.body.dataset.airglowAppUiReady === 'true'`,
      'app UI ready marker from sandbox frame',
    );
    const iframeSrc = await evaluate(cdp, appShell.sessionId, `document.querySelector('iframe')?.src || ''`);
    assert(String(iframeSrc).includes('/app-ui-sandbox.html?'), `app-shell iframe src is not sandbox UI: ${iframeSrc}`);

    const dashboard = await openExtensionPage(cdp, extensionId, 'dashboard.html');
    await waitForExpression(
      cdp,
      dashboard.sessionId,
      `document.body.innerText.includes('My Apps') && document.body.innerText.includes('Browser Smoke App')`,
      'dashboard My Apps',
      10000,
    );

    console.log(JSON.stringify({
      ok: true,
      extensionId,
      mockCloud: mockCloud.baseUrl,
      targetUrl: targetSite.targetUrl,
      savedAppId: saveResponse.cloud.appId,
      userScripts,
      requests: mockCloud.requests.map((request) => `${request.method} ${request.path}`),
      checks: [
        'extension-loaded',
        'user-scripts-enabled',
        'sidepanel-save-message',
        'private-app-registered',
        'page-userscript-injected',
        'app-shell-loaded',
        'dashboard-my-apps',
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
