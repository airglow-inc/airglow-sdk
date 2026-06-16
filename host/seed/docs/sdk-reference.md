# Airglow SDK reference

The `airglow` global is injected into every app context (userscript, UI iframe, startup, server function) before app code runs. App code has no `chrome.*` access — `airglow.*` is the only API.

---

## airglow.fetch(url, opts?)

A fetch that bypasses CORS by routing through the extension service worker. Returns `{ status, ok, json(), text() }` — no `headers`, `arrayBuffer`, or streaming. For same-origin requests, the native `fetch()` global is preferable. APIs that need a secret key belong in a server function (`airglow.rpc`) instead — `.env` keys are not available in browser code.

```ts
const res = await airglow.fetch('https://api.github.com/repos/oven-sh/bun/releases/latest');
const release = await res.json();
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

Structured logging. In browser contexts the most recent 1000 entries are kept (older ones are dropped) and queryable via `airglow browser logs` (see [`browser-debugging.md`](browser-debugging.md)); uncaught errors and unhandled promise rejections are auto-captured. In server functions the same API writes level-tagged lines into the daemon log (`~/.airglow/state/daemon.log`), attributed to the app and function.

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

## airglow.connectors

Third-party tools (Gmail, Notion, Google Sheets, … — ~1000 services) with platform-managed OAuth. Connections are scoped to your app. See the [app developer guide](app-developer-guide.md#connectors-third-party-tools-gmail-notion-sheets-) for the full flow; discover tool slugs and schemas with `airglow toolkit help`.

```ts
await airglow.connectors.connect(toolkit, opts?)     // OAuth popup; resolves once approved (client-only)
await airglow.connectors.status(toolkit, opts?)      // → { connected: boolean }
await airglow.connectors.disconnect(toolkit, opts?)
await airglow.connectors.execute(tool, args, opts?)  // → { data, successful, error }
```

`opts.account` is an optional label separating multiple identities on one service (use the account's email); default `"default"`. In server functions the same `airglow.connectors` global exists with `execute`/`status`/`disconnect` (no `connect` — popups are client-side).

```ts
const r = await airglow.connectors.execute('GMAIL_FETCH_EMAILS', { query: 'is:unread', max_results: 10 });
if (r.successful) render(r.data);
```

Errors carry `code`: `CONNECTOR_NOT_CONNECTED` (call `connect` first), `CONNECTOR_SIGNIN_REQUIRED` (the user must sign in to Airglow from the dashboard), `CONNECTOR_AUTH_CANCELLED` / `CONNECTOR_AUTH_TIMEOUT` (user closed or abandoned the popup).

---

## airglow.llm.anthropic.messages(payload)

Calls Anthropic's Messages API through the Airglow LLM gateway. The gateway centralises authentication, rate limiting, and billing — no app-side `ANTHROPIC_API_KEY` needed.

```ts
const res = await airglow.llm.anthropic.messages({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

`payload` is the [Anthropic Messages API request body](https://docs.claude.com/en/api/messages), passed through unchanged. The gateway returns the response unchanged. Per-user rate limits and request size caps apply server-side; failures reject with `AirglowError` (`code`, `status`, `requestId`).

Allowed models — one per tier: `claude-haiku-4-5`, `claude-sonnet-4-6` (default), `claude-opus-4-8`. Anything else rejects with `code: 'LLM_MODEL_NOT_ALLOWED'`.

Token usage bills against the same weekly Airglow usage limit as agent chat — one per-user pool, weighted by model price (Haiku 0.2×, Sonnet 0.6×, Opus 1×), so cheaper models stretch the budget further. When it is exhausted, calls reject with `code: 'LLM_BUDGET_EXCEEDED'` (HTTP 429) until the rolling 7-day window frees capacity.

Calls are proxied through the daemon to the gateway. For development, set `ANTHROPIC_API_KEY` in `~/.airglow/state/agent.env` to make the daemon call Anthropic directly with your own key (bypasses gateway limits).

Available in every context, including server functions — a server-side call loops back through the daemon, which attaches the user's identity itself (the auth token never enters the app subprocess).

---

## airglow.platform

Privileged extension capabilities. Registrations persist across service-worker restarts and are typically called from `startup.ts`.

```ts
await airglow.platform.allowIframes(['notion.so'], ['example.com']);
```

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
