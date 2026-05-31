# Airglow SDK reference

The `airglow` global is injected into every app context (userscript, UI iframe, startup, server function) before app code runs. App code has no `chrome.*` access — `airglow.*` is the only API.

---

## airglow.fetch(url, opts?)

A fetch that bypasses CORS by routing through the extension service worker. The target origin must match the app manifest's `host_permissions`. Returns `{ status, ok, json(), text() }` — no `headers`, `arrayBuffer`, or streaming. For same-origin requests, the native `fetch()` global is preferable.

```ts
const res = await airglow.fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': await airglow.storage.get('ANTHROPIC_API_KEY') },
  body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [...] }),
});
```

With `{ includeCookies: true }`, the request runs inside a tab on the target origin — cookies, `Sec-Fetch-*`, and `Origin` are indistinguishable from a request the user made. If no tab is open on the origin, a background tab is created for the request and closed afterward.

```ts
const res = await airglow.fetch('https://wallet.google.com/wallet/transactions', {
  includeCookies: true,
});
```

---

## airglow.storage

App-scoped key-value storage backed by `chrome.storage.local`. UI and userscripts share the namespace; apps cannot read each other's data.

```ts
await airglow.storage.get(key)         // → any | undefined
await airglow.storage.set(key, value)  // value must be JSON-serializable
await airglow.storage.delete(key)
await airglow.storage.list()           // → string[]
```

---

## airglow.log

Structured logging. The most recent 1000 entries are kept (older ones are dropped) and queryable via `localhost:3101/logs` (see [`browser-debugging.md`](browser-debugging.md)). Uncaught errors and unhandled promise rejections are auto-captured.

```ts
airglow.log.info('Tagged 25 articles', { count: 25 })
airglow.log.warn('Rate limit close', { remaining: 12 })
airglow.log.error('API call failed', { status: 429 })
```

---

## airglow.rpc(name, payload)

Calls a server function at `server/<name>.ts`.

```ts
const result = await airglow.rpc('tag', { titles: ['Show HN: ...'] });
// → runs server/tag.ts default export with body = { titles: [...] }
```

Transport failures and HTTP 4xx/5xx responses reject with `AirglowError` (`code`, `status`, `requestId`, `details`). A server function that returns `{ error }` with HTTP 200 comes back as a normal value.

---

## airglow.platform

Privileged extension capabilities. Registrations persist across service-worker restarts and are typically called from `startup.ts`.

```ts
await airglow.platform.registerRedirects([
  { domains: ['instagram.com', 'x.com'], target: 'airglow://focus-blocker?site=instagram.com' }
]);

await airglow.platform.allowIframes(['notion.so'], ['example.com']);
```

- `airglow://{appId}` resolves to the app's UI.
- `registerRedirects` replaces previous registrations on each call.
- `allowIframes(domains, initiators?)` strips `X-Frame-Options` / CSP `frame-ancestors` so the listed `domains` can be framed. Optional `initiators` restricts which parent origins are allowed.

---

## airglow.openWindow / openWindowAndWaitClose

```ts
await airglow.openWindow('https://example.com', { width: 800, height: 600 });
await airglow.openWindowAndWaitClose(authUrl, { width: 520, height: 720 }); // OAuth
```

Options: `width`, `height` (default 800×600), `left`, `top`, `popup` (default `true`). Use these in userscripts — `window.open()` doesn't work there (isolated `window`).

---

## airglow.captureTab()

Captures the visible area of the userscript's host tab as JPEG.

```ts
const { base64, mediaType } = await airglow.captureTab();
// mediaType === 'image/jpeg', base64 has no data: prefix
```

---

## airglow.sdkVersion

SDK contract version (currently `0.1.0-beta.1`).
