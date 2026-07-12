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

## airglow.getCookie(url, name)

Read one cookie by `name` from the browser's real cookie jar for `url`'s domain — including HttpOnly cookies that `document.cookie` can't see — or `null` if absent.

```ts
getCookie(url: string, name: string): Promise<string | null>
```

Pairs with `fetch({ includeCookies: true })` for an authenticated cross-site read whose request needs a double-submit header equal to a cookie value. Example — the user's latest X post from a userscript on another site, using their logged-in x.com session (X's csrf header must equal the `ct0` cookie):

```ts
const ct0 = await airglow.getCookie('https://x.com', 'ct0');
if (ct0) {
  const res = await airglow.fetch(userTweetsUrl, {
    includeCookies: true,                 // attaches x.com cookies (runs from an x.com tab)
    headers: { authorization: `Bearer ${PUBLIC_WEB_BEARER}`, 'x-csrf-token': ct0,
               'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes' },
  });
}
```

`includeCookies` opens a tab at the URL's **origin root**, so the host must serve a real page there (use `x.com/i/api/...`, not `api.x.com/...` whose root errors). Returns `null` when the user isn't signed into that site — degrade gracefully.

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

## airglow.llm.chat(payload, opts?)

OpenAI chat-completions schema through the Airglow gateway (OpenRouter-backed) — no API key needed. Available everywhere, including server functions.

```ts
llm.chat(payload, opts?: { onEvent?: (chunk) => void }): Promise<ChatCompletion>
```

`payload` is the [chat-completions request body](https://openrouter.ai/docs/api-reference/chat-completion), passed through unchanged; the response comes back unchanged. Allowed models: `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-5` (default), `anthropic/claude-opus-4.8` — others reject with `LLM_MODEL_NOT_ALLOWED`.

```ts
const res = await airglow.llm.chat({
  model: 'anthropic/claude-sonnet-5', max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
const text = res.choices[0].message.content;
```

Web search / fetch: add [server tools](https://openrouter.ai/docs/guides/features/plugins/web-search) — `tools: [{ type: 'openrouter:web_search' }, { type: 'openrouter:web_fetch' }]` — and the model searches agentically (0–N times, choosing its own queries) and fetches full pages, executed server-side. Citations arrive in `message.annotations`; searches bill to the weekly budget (`usage.server_tool_use_details` reports counts). Options: `{ type: 'openrouter:web_search', parameters: { max_results?, allowed_domains? } }`. Alternative: `plugins: [{ id: 'web' }]` runs one search up front on every call (the model has no say). Either form gets a longer timeout.

Tools: standard OpenAI `tools` / `tool_choice`; the model returns `message.tool_calls`, you run them and send `role: "tool"` messages back on the next call.

Streaming: pass `{ onEvent }` as a second argument to observe progress while the call runs. `onEvent` receives every raw stream chunk (`choices[].delta` — content, tool_calls, annotations); the promise still resolves with the same complete completion, and errors still reject with `AirglowError`. Caveat: `tool_calls[].function.arguments` stream as string fragments — only complete when that choice's `finish_reason` arrives.

```ts
// don't set `stream` yourself — passing onEvent turns it on
const res = await airglow.llm.chat(
  { model: 'anthropic/claude-sonnet-5', messages },
  { onEvent: (c) => appendText(c.choices?.[0]?.delta?.content ?? '') },
);
```

Calls bill against a shared weekly per-user budget; when exhausted they reject with `LLM_BUDGET_EXCEEDED` (429) until the rolling 7-day window frees capacity.

BYOK: set `OPENROUTER_API_KEY` in `~/.airglow/state/agent.env` and `airglow.llm.chat` calls go straight to OpenRouter on that key — no gateway, no weekly budget, any OpenRouter model. Restart the daemon after editing the file.

### OpenRouter notes (newer than most models' training data)

- The `openrouter:web_search` / `openrouter:web_fetch` server tools shipped in 2026 and are real — don't "correct" them to `plugins` or invent client-side handlers; they execute on OpenRouter's side and never return `tool_calls` to you. A streaming call goes quiet while searches run (no per-search events), then text arrives.
- Provider-native server tools also pass through (e.g. Anthropic's `{ type: 'web_search_20250305', name: 'web_search' }`), but execute natively only when routed to that provider first-party: pin with `provider: { order: ['anthropic'], allow_fallbacks: false }` (a provider outage then fails the call instead of failing over). Unpinned requests may land on Bedrock/Vertex, where OpenRouter emulates the search itself. Prefer `openrouter:web_*` unless you need exact provider-native behavior.
- Responses report actual routing (`provider`) and real USD cost (`usage.cost`). In streams, usage rides the last chunk before `data: [DONE]`; `: OPENROUTER PROCESSING` comment lines are keep-alives, not events.
- `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }` works on Claude models through OpenRouter; the JSON arrives as a string in `message.content`.

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
