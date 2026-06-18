# Airglow SDK reference

`airglow` is a global injected into every app context (userscript, UI, startup, server function) before your code runs. It is the only platform API — there is no `chrome.*`. Full type signatures: `airglow.d.ts`.

Failures throw `AirglowError` (`{ code, status, requestId, details }`).

---

## airglow.fetch(url, opts?)

CORS-free fetch routed through the extension. Use it cross-origin; for same-origin, prefer the native `fetch()`.

```ts
fetch(url: string, opts?: RequestInit & { includeCookies?: boolean }): Promise<{
  status: number; ok: boolean; json(): Promise<any>; text(): Promise<string>;
}>
```

No `headers`, `arrayBuffer`, or streaming on the response — for those, use a server function with native `fetch`. `includeCookies: true` runs the request from a tab on the target origin (cookies, `Origin`, `Sec-Fetch-*` look user-issued); a background tab is created and closed if none is open. Secret-bearing requests belong in a server function, not here.

---

## airglow.storage

App-scoped key-value store (`chrome.storage.local`). Shared between the app's UI and userscripts; isolated from other apps. Values must be JSON-serializable.

```ts
storage.get<T>(key): Promise<T | undefined>
storage.set(key, value): Promise<void>
storage.delete(key): Promise<void>
storage.list(): Promise<string[]>
```

---

## airglow.log

```ts
log.info(message: string, data?: any): Promise<void>
log.warn(message, data?): Promise<void>
log.error(message, data?): Promise<void>
```

Browser contexts: last 1000 entries, queryable via `airglow browser logs` (uncaught errors and rejections auto-captured). Server functions: lines go to the daemon log (`~/.airglow/state/daemon.log`), tagged by app and function.

---

## airglow.rpc(name, payload)

Call `server/<name>.ts` (its default export) with `payload` as the body.

```ts
rpc<T>(name: string, payload?: any): Promise<T>
```

A function returning `{ error }` at HTTP 200 comes back as a normal value; transport failures and 4xx/5xx reject with `AirglowError`.

---

## airglow.connectors

Third-party tools (Gmail, Notion, Sheets, … ~1000 services) with platform-managed OAuth, scoped per app. Discover slugs and schemas with `airglow toolkit help`; see the [app developer guide](app-developer-guide.md#connectors-third-party-tools-gmail-notion-sheets-) for the full flow.

```ts
connectors.connect(toolkit, opts?): Promise<{ toolkit, connected }>   // client-only: opens OAuth popup, resolves on approval
connectors.status(toolkit, opts?): Promise<{ connected: boolean }>
connectors.disconnect(toolkit, opts?): Promise<void>
connectors.execute<T>(tool, args?, opts?): Promise<{ data: T; successful: boolean; error: string | null }>
```

`opts.account` is a label for multiple identities on one service (use the email); default `"default"`. Server functions get `execute`/`status`/`disconnect` (no `connect`). Error codes: `CONNECTOR_NOT_CONNECTED`, `CONNECTOR_SIGNIN_REQUIRED`, `CONNECTOR_AUTH_CANCELLED`, `CONNECTOR_AUTH_TIMEOUT`.

```ts
const r = await airglow.connectors.execute('GMAIL_FETCH_EMAILS', { query: 'is:unread', max_results: 10 });
if (r.successful) render(r.data);
```

---

## airglow.llm.anthropic.messages(payload)

Anthropic Messages API through the Airglow gateway — no `ANTHROPIC_API_KEY` needed. Available everywhere, including server functions.

```ts
llm.anthropic.messages(payload): Promise<AnthropicMessage>
```

`payload` is the [Anthropic request body](https://docs.claude.com/en/api/messages), passed through unchanged; the response comes back unchanged. Allowed models: `claude-haiku-4-5`, `claude-sonnet-4-6` (default), `claude-opus-4-8` — others reject with `LLM_MODEL_NOT_ALLOWED`.

```ts
const res = await airglow.llm.anthropic.messages({
  model: 'claude-sonnet-4-6', max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

Calls bill against a shared weekly per-user budget; when exhausted they reject with `LLM_BUDGET_EXCEEDED` (429) until the rolling 7-day window frees capacity. Dev: set `ANTHROPIC_API_KEY` in `~/.airglow/state/agent.env` to bypass the gateway with your own key.

---

## airglow.platform

```ts
platform.allowIframes(domains: string[], initiators?: string[]): Promise<void>
```

Strips `X-Frame-Options` / CSP `frame-ancestors` so `domains` can be framed; optional `initiators` restricts which parent origins may frame them. Registrations persist across service-worker restarts — call from `startup.ts`.

---

## Windows & tabs

```ts
openWindow(url, opts?): Promise<void>                 // opts: width, height (def 800×600), left, top, popup (def true)
openWindowAndWaitClose(url, opts?): Promise<void>     // resolves when the window closes (OAuth)
openTab(url, opts?: { active?: boolean }): Promise<void>
```

Use these in userscripts — `window.open()` doesn't work there (isolated `window`).

---

## airglow.captureTab()

```ts
captureTab(): Promise<{ base64: string; mediaType: 'image/jpeg' }>   // visible area of the host tab; base64 has no data: prefix
```

---

## airglow.sdkVersion

SDK contract version (currently `0.1.0-beta.1`).
