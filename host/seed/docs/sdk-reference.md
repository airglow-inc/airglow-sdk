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

## airglow.llm.anthropic.messages(payload, opts?)

Anthropic Messages API through the Airglow gateway — no `ANTHROPIC_API_KEY` needed. Available everywhere, including server functions.

```ts
llm.anthropic.messages(payload, opts?: { onEvent?: (event) => void }): Promise<AnthropicMessage>
```

`payload` is the [Anthropic request body](https://docs.claude.com/en/api/messages), passed through unchanged; the response comes back unchanged. Allowed models: `claude-haiku-4-5`, `claude-sonnet-5` (default), `claude-opus-4-8` — others reject with `LLM_MODEL_NOT_ALLOWED`.

```ts
const res = await airglow.llm.anthropic.messages({
  model: 'claude-sonnet-5', max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

Server tools: set `web_search` (live web search with cited sources) and/or `web_fetch` (fetch a URL already present in the conversation — the model never invents URLs, so include the URL in the prompt). Pass `true` for defaults or an options object: `web_search: { max_uses?, allowed_domains?, blocked_domains? }` (max_uses 1-10, default 5; each search bills to the weekly budget), `web_fetch: { max_uses?, allowed_domains?, blocked_domains?, max_content_tokens? }` (max_uses 1-10, default 3; max_content_tokens caps how much of a page enters the context — default 20000, max 50000; fetched content bills as input tokens). The response `content` then carries `server_tool_use` and `web_search_tool_result` / `web_fetch_tool_result` blocks; server-tool calls get a higher max_tokens ceiling (8000) and a longer timeout.

Client tools: pass `tools` (`{ name, description?, input_schema }`) and optional `tool_choice`; the model returns `tool_use` blocks, you run them and send `tool_result` blocks back on the next call. Hosted/server tools are rejected in `tools[]` — use the `web_search` / `web_fetch` params instead.

Streaming: pass `{ onEvent }` as a second argument to observe progress while the call runs — useful to surface web-search queries or partial text during a long server-tool call. `onEvent` receives every raw [Anthropic SSE event](https://docs.claude.com/en/api/messages-streaming) (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`); the promise still resolves with the same complete message, and errors still reject with `AirglowError`. Caveat: a `server_tool_use` / `tool_use` block's `input` (e.g. the search query) streams as `input_json_delta` fragments — it is only complete at that block's `content_block_stop`.

```ts
const res = await airglow.llm.anthropic.messages(
  { model: 'claude-sonnet-5', web_search: true, messages },
  { onEvent: (e) => { if (e.type === 'content_block_stop') updateProgress(); } },
);
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

SDK contract version (currently `0.1.0-beta.2`).
