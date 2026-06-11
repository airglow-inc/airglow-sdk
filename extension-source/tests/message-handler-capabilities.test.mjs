import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

async function loadMessageHandler() {
  const dir = await mkdtemp(join(tmpdir(), 'airglow-message-handler-'));
  const source = await readFile(fileURLToPath(new URL('../lib/airglow-message-handler.ts', import.meta.url)), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });

  await writeFile(join(dir, 'logger.js'), `
exports.logger = {
  info() {},
  warn() {},
  error() {},
};
`);
  await writeFile(join(dir, 'airglow-identity.js'), `
exports.USER_EMAIL_KEY = '__user_email';
exports.normalizeUserEmail = (email) => typeof email === 'string' && email.includes('@') ? email : undefined;
exports.buildIdentityHeaders = () => ({});
exports.getAirglowIdentity = async () => ({});
exports.getAirglowIdentityHeaders = async () => ({});
`);
  await writeFile(join(dir, 'analytics.js'), `
exports.trackIdentified = async () => {};
`);
  await writeFile(join(dir, 'airglow-world-id.js'), `
exports.airglowUserScriptWorldId = (appId) => 'airglow_' + String(appId).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120);
`);
  const outfile = join(dir, 'airglow-message-handler.cjs');
  await writeFile(outfile, transpiled.outputText);
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  const loaded = mod.default ?? mod;
  return {
    ...loaded,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function resultForKeys(store, keys) {
  if (keys == null) return { ...store };
  if (typeof keys === 'string') return { [keys]: store[keys] };
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((key) => [key, store[key]]));
  }
  return {};
}

function installChromeStub(options = {}) {
  const calls = [];
  const store = {};
  const runtimeApprovalResult = options.runtimeApprovalResult ?? true;
  const scriptingResult = options.scriptingResult;
  globalThis.chrome = {
    runtime: { lastError: null },
    identity: {
      getRedirectURL() {
        calls.push(['identity.getRedirectURL']);
        return 'https://extension.test/redirect';
      },
    },
    storage: {
      local: {
        get(keys, callback) {
          calls.push(['storage.get', keys]);
          const result = resultForKeys(store, keys);
          if (callback) {
            queueMicrotask(() => callback(result));
            return undefined;
          }
          return Promise.resolve(result);
        },
        set(values, callback) {
          calls.push(['storage.set', values]);
          Object.assign(store, values);
          if (callback) queueMicrotask(callback);
          return Promise.resolve();
        },
        remove(keys, callback) {
          calls.push(['storage.remove', keys]);
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
          if (callback) queueMicrotask(callback);
          return Promise.resolve();
        },
      },
    },
    tabs: {
      async query(query) {
        calls.push(['tabs.query', query]);
        return [];
      },
      create(options, callback) {
        calls.push(['tabs.create', options]);
        const tab = { id: 42, windowId: 7 };
        if (callback) queueMicrotask(() => callback(tab));
        return Promise.resolve(tab);
      },
      get(tabId, callback) {
        calls.push(['tabs.get', tabId]);
        queueMicrotask(() => callback({ id: tabId, windowId: 7 }));
      },
      remove(tabId) {
        calls.push(['tabs.remove', tabId]);
        return Promise.resolve();
      },
      onUpdated: {
        addListener(listener) {
          calls.push(['tabs.onUpdated.addListener']);
          queueMicrotask(() => listener(42, { status: 'complete' }));
        },
        removeListener() {
          calls.push(['tabs.onUpdated.removeListener']);
        },
      },
      captureVisibleTab(windowId, options, callback) {
        calls.push(['tabs.captureVisibleTab', windowId, options]);
        queueMicrotask(() => callback('data:image/jpeg;base64,abc123'));
      },
    },
    windows: {
      getCurrent(callback) {
        calls.push(['windows.getCurrent']);
        queueMicrotask(() => callback({ left: 0, top: 0, width: 1200, height: 800 }));
      },
      create(options, callback) {
        calls.push(['windows.create', options]);
        queueMicrotask(() => callback({ id: 11, tabs: [{ id: 42 }] }));
      },
      remove(windowId, callback) {
        calls.push(['windows.remove', windowId]);
        if (callback) queueMicrotask(callback);
      },
      onRemoved: {
        addListener() {
          calls.push(['windows.onRemoved.addListener']);
        },
        removeListener() {
          calls.push(['windows.onRemoved.removeListener']);
        },
      },
    },
    webNavigation: {
      onBeforeNavigate: {
        addListener() {
          calls.push(['webNavigation.onBeforeNavigate.addListener']);
        },
        removeListener() {
          calls.push(['webNavigation.onBeforeNavigate.removeListener']);
        },
      },
    },
    scripting: {
      async executeScript(scriptOptions) {
        calls.push(['scripting.executeScript', scriptOptions]);
        if (Array.isArray(scriptOptions.args) && String(scriptOptions.args[0] || '').startsWith('Airglow app ')) {
          return [{ result: runtimeApprovalResult }];
        }
        if (scriptingResult !== undefined) return [{ result: scriptingResult }];
        if (scriptOptions?.world === 'MAIN' && typeof scriptOptions?.args?.[0] === 'string' && Array.isArray(scriptOptions?.args?.[1])) {
          return [{ result: { ok: true, method: 'monaco', modelUri: 'inmemory://model/solution.js' } }];
        }
        return [{ result: { status: 200, body: '{"ok":true}' } }];
      },
    },
  };
  globalThis.fetch = async (url, options) => {
    calls.push(['fetch', url, options]);
    return {
      ok: true,
      status: 200,
      headers: { get: () => undefined },
      text: async () => '{"ok":true}',
    };
  };
  return { calls, store };
}

function manifest(capabilities = []) {
  return {
    id: 'app',
    name: 'App',
    version: '1.0.0',
    description: 'Test app',
    capabilities,
    host_permissions: ['https://example.com/*'],
    _source: { url: 'http://127.0.0.1:3222', type: 'local' },
    _sourceType: 'local',
  };
}

function manifestWithId(id, capabilities = []) {
  return { ...manifest(capabilities), id };
}

function invoke(handler, msg, sender = {}) {
  return new Promise((resolve) => {
    let handled;
    const complete = (response) => queueMicrotask(() => resolve({ handled, response }));
    handled = handler.handleAirglowMessage(
      { _airglow: true, _appId: 'app', ...msg },
      sender,
      complete,
    );
  });
}

function invokeApp(handler, appId, msg, sender = {}) {
  return new Promise((resolve) => {
    let handled;
    const complete = (response) => queueMicrotask(() => resolve({ handled, response }));
    handled = handler.handleAirglowMessage(
      { _airglow: true, _appId: appId, ...msg },
      sender,
      complete,
    );
  });
}

test('runtime UX capability map is conditional for cookie/page fetch', async () => {
  const handler = await loadMessageHandler();
  try {
    assert.equal(handler.requiredRuntimeUxCapabilityForMessage({ type: 'airglow:fetch', includeCookies: false }), undefined);
    assert.equal(
      handler.requiredRuntimeUxCapabilityForMessage({ type: 'airglow:fetch', includeCookies: true }),
      handler.RUNTIME_UX_CAPABILITIES.fetchIncludeCookies,
    );
    assert.equal(
      handler.requiredRuntimeUxCapabilityForMessage({ type: 'airglow:openTab' }),
      handler.RUNTIME_UX_CAPABILITIES.openTab,
    );
    assert.equal(
      handler.requiredRuntimeUserApprovalCapabilityForMessage({ type: 'airglow:openTab' }),
      handler.RUNTIME_UX_CAPABILITIES.openTab,
    );
    assert.equal(handler.requiredRuntimeUserApprovalCapabilityForMessage({ type: 'airglow:captureTab' }), undefined);
    assert.equal(handler.requiredRuntimeUserApprovalCapabilityForMessage({ type: 'airglow:fetch', includeCookies: true }), undefined);
    assert.equal(handler.requiredRuntimeUxCapabilityForMessage({ type: 'airglow:storage:get' }), undefined);
  } finally {
    await handler.cleanup();
  }
});

test('runtime UX messages are denied before Chrome UX APIs without manifest capabilities', async () => {
  const handler = await loadMessageHandler();
  try {
    const { calls } = installChromeStub();
    handler.setAppManifests([manifest()]);

    const cases = [
      [{ type: 'airglow:openTab', url: 'https://example.com' }, 'browser.openTab'],
      [{ type: 'airglow:openWindow', url: 'https://example.com' }, 'browser.openWindow'],
      [{ type: 'airglow:captureTab' }, 'browser.captureTab'],
      [{ type: 'airglow:platform:registerRedirects', rules: [] }, 'platform.registerRedirects'],
      [{ type: 'airglow:platform:allowIframes', domains: ['example.com'] }, 'platform.allowIframes'],
      [{ type: 'airglow:fetch', url: 'https://example.com/data', includeCookies: true }, 'fetch.includeCookies'],
      [{ type: 'airglow:identity:launchWebAuthFlow', url: 'https://example.com/auth' }, 'identity.launchWebAuthFlow'],
    ];

    for (const [msg, capability] of cases) {
      calls.length = 0;
      const { handled, response } = await invoke(handler, msg, { tab: { id: 1 } });
      assert.equal(handled, true);
      assert.equal(response.code, 'CAPABILITY_DENIED');
      assert.equal(response.capability, capability);
      assert.equal(calls.length, 0, msg.type);
    }
  } finally {
    await handler.cleanup();
  }
});

test('userscript sender world validation accepts sanitized private app ids', async () => {
  const handler = await loadMessageHandler();
  try {
    installChromeStub();
    const appId = 'private-593948ed4e-8c0d7f3f07';
    handler.setAppManifests([manifestWithId(appId)]);

    const ok = await invokeApp(
      handler,
      appId,
      { type: 'airglow:storage:get', key: 'summary' },
      { userScriptWorldId: 'airglow_private_593948ed4e_8c0d7f3f07' },
    );
    assert.equal(ok.response.error, undefined);

    const bad = await invokeApp(
      handler,
      appId,
      { type: 'airglow:storage:get', key: 'summary' },
      { userScriptWorldId: 'airglow_private_other' },
    );
    assert.match(bad.response.error, /appId mismatch/);
  } finally {
    await handler.cleanup();
  }
});

test('baseline storage, log, identity getter, and safe host fetch do not need UX capabilities', async () => {
  const handler = await loadMessageHandler();
  try {
    const { calls } = installChromeStub();
    handler.setAppManifests([manifest()]);

    assert.deepEqual((await invoke(handler, { type: 'airglow:storage:set', key: 'k', value: 'v' })).response, { ok: true });
    assert.deepEqual((await invoke(handler, { type: 'airglow:log', level: 'info', message: 'hi' })).response, { ok: true });
    assert.deepEqual(
      (await invoke(handler, { type: 'airglow:identity:getRedirectURL' })).response,
      { url: 'https://extension.test/redirect' },
    );

    const fetchResult = await invoke(handler, { type: 'airglow:fetch', url: 'https://example.com/data' });
    assert.equal(fetchResult.response.status, 200);
    assert.deepEqual(fetchResult.response.body, { ok: true });
    assert.ok(calls.some(([name]) => name === 'fetch'));
    assert.equal(calls.some(([name]) => name === 'tabs.create'), false);
    assert.equal(calls.some(([name]) => name === 'scripting.executeScript'), false);
  } finally {
    await handler.cleanup();
  }
});

test('page editor replacement runs in the sender frame main world without browser UX capability', async () => {
  const handler = await loadMessageHandler();
  try {
    const { calls } = installChromeStub({
      scriptingResult: { ok: true, method: 'monaco', modelUri: 'inmemory://model/solution.js' },
    });
    handler.setAppManifests([manifest()]);

    assert.equal(
      handler.requiredRuntimeUxCapabilityForMessage({ type: 'airglow:page:replaceEditorText' }),
      undefined,
    );
    assert.equal(
      handler.requiredRuntimeUserApprovalCapabilityForMessage({ type: 'airglow:page:replaceEditorText' }),
      undefined,
    );

    const result = await invoke(
      handler,
      {
        type: 'airglow:page:replaceEditorText',
        text: 'class Solution { public: vector<int> twoSum(vector<int>& nums, int target) { return {}; } };',
        selectors: ['.monaco-editor textarea.inputarea'],
      },
      { tab: { id: 99 }, frameId: 2, url: 'https://leetcode.com/problems/two-sum/' },
    );

    assert.deepEqual(result.response, {
      result: { ok: true, method: 'monaco', modelUri: 'inmemory://model/solution.js' },
    });
    const executeCall = calls.find(([name]) => name === 'scripting.executeScript');
    assert.ok(executeCall);
    assert.equal(executeCall[1].world, 'MAIN');
    assert.deepEqual(executeCall[1].target, { tabId: 99, frameIds: [2] });
    assert.equal(executeCall[1].args[1][0], '.monaco-editor textarea.inputarea');
  } finally {
    await handler.cleanup();
  }
});

test('appStorageKey matches the app-scoped storage namespace', async () => {
  const handler = await loadMessageHandler();
  try {
    assert.equal(handler.appStorageKey('private-app', 'latestPageContext'), 'airglow:app:private-app:latestPageContext');
  } finally {
    await handler.cleanup();
  }
});

test('fetchWithTimeout aborts with a readable timeout reason', async () => {
  const handler = await loadMessageHandler();
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason));
      });
    };
    await assert.rejects(
      () => handler.fetchWithTimeout('https://example.com/slow', {}, 5),
      /Airglow request timed out after 5ms/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    await handler.cleanup();
  }
});

test('LLM gateway errors surface nested public messages', async () => {
  const handler = await loadMessageHandler();
  const previousFetch = globalThis.fetch;
  try {
    installChromeStub();
    handler.setAppManifests([manifest()]);
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: {
          code: 'LLM_MODEL_NOT_ALLOWED',
          message: 'Requested Anthropic model is not allowed',
          requestId: 'req-nested',
        },
      }),
    });

    const result = await invoke(handler, {
      type: 'airglow:llm:anthropic:messages',
      payload: { model: 'bad-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(result.response.error, 'Requested Anthropic model is not allowed');
    assert.equal(result.response.code, 'LLM_MODEL_NOT_ALLOWED');
    assert.equal(result.response.status, 400);
    assert.equal(result.response.requestId, 'req-nested');
  } finally {
    globalThis.fetch = previousFetch;
    await handler.cleanup();
  }
});

test('declared capabilities still require runtime approval before browser UX APIs', async () => {
  const handler = await loadMessageHandler();
  try {
    const { calls } = installChromeStub();
    handler.setAppManifests([manifest(['browser.openTab', 'fetch.includeCookies'])]);

    const openTabResult = await invoke(handler, { type: 'airglow:openTab', url: 'https://example.com' });
    assert.equal(openTabResult.response.code, 'RUNTIME_USER_APPROVAL_DENIED');
    assert.equal(openTabResult.response.capability, 'browser.openTab');
    assert.equal(calls.some(([name]) => name === 'tabs.create'), false);

    calls.length = 0;
    const fetchResult = await invoke(handler, {
      type: 'airglow:fetch',
      url: 'https://example.com/data',
      includeCookies: true,
    });
    assert.equal(fetchResult.response.status, 200);
    assert.deepEqual(fetchResult.response.body, { ok: true });
    assert.ok(calls.some(([name]) => name === 'tabs.query'));
    assert.ok(calls.some(([name, options]) => name === 'tabs.create' && options.active === false));
    assert.ok(calls.some(([name, options]) => name === 'scripting.executeScript' && options.world === 'MAIN'));
  } finally {
    await handler.cleanup();
  }
});

test('trusted app-shell approval marker allows browser UX APIs after capability check', async () => {
  const handler = await loadMessageHandler();
  try {
    const { calls } = installChromeStub();
    handler.setAppManifests([manifest(['browser.openTab'])]);

    const openTabResult = await invoke(
      handler,
      {
        type: 'airglow:openTab',
        url: 'https://example.com',
        _airglowRuntimeUserApproved: true,
      },
      { url: 'chrome-extension://extension-id/app-shell.html?app=app' },
    );
    assert.deepEqual(openTabResult.response, { ok: true, tabId: 42 });
    assert.ok(calls.some(([name]) => name === 'tabs.create'));
    assert.equal(calls.some(([name]) => name === 'scripting.executeScript'), false);
  } finally {
    await handler.cleanup();
  }
});

test('content-script UX requests ask in the sender tab before browser APIs run', async () => {
  const handler = await loadMessageHandler();
  try {
    const { calls } = installChromeStub({ runtimeApprovalResult: true });
    handler.setAppManifests([manifest(['browser.openWindow'])]);

    const openWindowResult = await invoke(
      handler,
      { type: 'airglow:openWindow', url: 'https://example.com' },
      { tab: { id: 99 }, url: 'https://example.com/page' },
    );
    assert.deepEqual(openWindowResult.response, { ok: true, windowId: 11 });
    assert.ok(calls.some(([name, options]) => name === 'scripting.executeScript' && options.target.tabId === 99));
    assert.ok(calls.some(([name]) => name === 'windows.create'));
  } finally {
    await handler.cleanup();
  }
});

test('content-script UX requests stop when the sender-tab approval is denied', async () => {
  const handler = await loadMessageHandler();
  try {
    const { calls } = installChromeStub({ runtimeApprovalResult: false });
    handler.setAppManifests([manifest(['browser.openWindow'])]);

    const openWindowResult = await invoke(
      handler,
      { type: 'airglow:openWindow', url: 'https://example.com' },
      { tab: { id: 99 }, url: 'https://example.com/page' },
    );
    assert.equal(openWindowResult.response.code, 'RUNTIME_USER_APPROVAL_DENIED');
    assert.equal(openWindowResult.response.capability, 'browser.openWindow');
    assert.ok(calls.some(([name]) => name === 'scripting.executeScript'));
    assert.equal(calls.some(([name]) => name === 'windows.create'), false);
  } finally {
    await handler.cleanup();
  }
});

test('content-script senders cannot spoof the app-shell approval marker', async () => {
  const handler = await loadMessageHandler();
  try {
    const { calls } = installChromeStub({ runtimeApprovalResult: false });
    handler.setAppManifests([manifest(['browser.openTab'])]);

    const openTabResult = await invoke(
      handler,
      {
        type: 'airglow:openTab',
        url: 'https://example.com',
        _airglowRuntimeUserApproved: true,
      },
      { tab: { id: 99 }, url: 'https://example.com/page' },
    );
    assert.equal(openTabResult.response.code, 'RUNTIME_USER_APPROVAL_DENIED');
    assert.ok(calls.some(([name]) => name === 'scripting.executeScript'));
    assert.equal(calls.some(([name]) => name === 'tabs.create'), false);
  } finally {
    await handler.cleanup();
  }
});
