import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

async function loadIdentityModule() {
  const dir = await mkdtemp(join(tmpdir(), 'airglow-identity-'));
  let source = await readFile(fileURLToPath(new URL('../lib/airglow-identity.ts', import.meta.url)), 'utf8');
  source = source
    .replaceAll('import.meta.env.WXT_CLOUD_APP_SOURCE_URL', JSON.stringify('https://cloud.test'))
    .replaceAll('import.meta.env.WXT_OFFICIAL_APP_SOURCE_URL', 'undefined');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const outfile = join(dir, 'airglow-identity.cjs');
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(dir, 'node_modules'), 'dir');
  await writeFile(outfile, transpiled.outputText);
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return {
    ...(mod.default ?? mod),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function resultForKeys(store, keys) {
  if (keys == null) return { ...store };
  if (typeof keys === 'string') return { [keys]: store[keys] };
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
  return {};
}

function installChromeStub() {
  const store = {};
  const calls = [];
  globalThis.chrome = {
    runtime: { lastError: null },
    identity: {
      getRedirectURL(path = '') {
        calls.push(['identity.getRedirectURL', path]);
        return `https://extension.test/${path}`;
      },
      launchWebAuthFlow(input, callback) {
        calls.push(['identity.launchWebAuthFlow', input]);
        queueMicrotask(() => callback('https://extension.test/airglow-auth?code=oauth-code'));
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
  };
  return { store, calls };
}

test('Google sign-in stores validated Airglow identity session', async () => {
  const identity = await loadIdentityModule();
  const chromeStub = installChromeStub();
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url) === 'https://cloud.test/api/config') {
      return new Response(JSON.stringify({
        identity: {
          googleOAuthEnabled: true,
          supabaseUrl: 'https://example.supabase.co',
          supabasePublishableKey: 'sb_publishable_test',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url) === 'https://example.supabase.co/auth/v1/token?grant_type=pkce') {
      const body = JSON.parse(String(init.body));
      assert.equal(body.auth_code, 'oauth-code');
      assert.equal(typeof body.code_verifier, 'string');
      assert.ok(body.code_verifier.length > 20);
      return new Response(JSON.stringify({
        access_token: 'oauth-access',
        expires_in: 3600,
        refresh_token: 'oauth-refresh',
        token_type: 'bearer',
        user: {
          id: 'user-123',
          aud: 'authenticated',
          role: 'authenticated',
          email: 'User@Example.com',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url) === 'https://cloud.test/api/identity/session') {
      assert.equal(init.headers.Authorization, 'Bearer oauth-access');
      assert.deepEqual(JSON.parse(String(init.body)), { refreshToken: 'oauth-refresh' });
      return new Response(JSON.stringify({
        ok: true,
        userId: 'supabase:user-123',
        userEmail: 'User@Example.com',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const state = await identity.signInAirglowWithGoogle();
    assert.deepEqual(state, {
      authenticated: true,
      userId: 'supabase:user-123',
      email: 'user@example.com',
      provider: 'google',
    });
    assert.equal(chromeStub.store.__airglow_session_token, 'oauth-access');
    assert.equal(chromeStub.store.__airglow_refresh_token, 'oauth-refresh');
    assert.equal(chromeStub.store.__airglow_user_id, 'supabase:user-123');
    assert.equal(chromeStub.store.__airglow_user_email, 'user@example.com');
    assert.equal(chromeStub.store.__airglow_auth_provider, 'google');
    const launchCall = chromeStub.calls.find(([name]) => name === 'identity.launchWebAuthFlow');
    assert.ok(launchCall);
    assert.match(launchCall[1].url, /^https:\/\/example\.supabase\.co\/auth\/v1\/authorize\?/);
    const authorizeUrl = new URL(launchCall[1].url);
    assert.equal(authorizeUrl.searchParams.get('provider'), 'google');
    assert.equal(authorizeUrl.searchParams.get('redirect_to'), 'https://extension.test/airglow-auth');
    assert.equal(authorizeUrl.searchParams.get('scopes'), 'email profile');
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 's256');
    assert.ok(authorizeUrl.searchParams.get('code_challenge'));
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
    await identity.cleanup();
  }
});

test('Airglow sign-out clears stored auth identity', async () => {
  const identity = await loadIdentityModule();
  const { store } = installChromeStub();
  Object.assign(store, {
    __airglow_session_token: 'token',
    __airglow_refresh_token: 'refresh',
    __airglow_user_id: 'supabase:user-123',
    __airglow_user_email: 'user@example.com',
    __airglow_auth_provider: 'google',
  });

  try {
    assert.deepEqual(await identity.signOutAirglowIdentity(), { authenticated: false });
    assert.deepEqual(store, {});
  } finally {
    delete globalThis.chrome;
    await identity.cleanup();
  }
});

test('anonymous Supabase sessions do not make the UI look Google signed-in', async () => {
  const identity = await loadIdentityModule();
  const { store } = installChromeStub();
  Object.assign(store, {
    __airglow_session_token: 'anonymous-token',
    __airglow_refresh_token: 'anonymous-refresh',
    __airglow_user_id: 'supabase:anonymous-user',
  });

  try {
    assert.deepEqual(await identity.getStoredAirglowAuthState(), {
      authenticated: false,
      userId: 'supabase:anonymous-user',
    });
    store.__airglow_auth_provider = 'google';
    assert.deepEqual(await identity.getStoredAirglowAuthState(), {
      authenticated: true,
      userId: 'supabase:anonymous-user',
      provider: 'google',
    });
  } finally {
    delete globalThis.chrome;
    await identity.cleanup();
  }
});
