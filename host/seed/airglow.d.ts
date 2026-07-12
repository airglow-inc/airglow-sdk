/** Airglow SDK - available globally in userscripts, UI, and startup code. */
type AirglowSdkVersion = '0.1.0-beta.2';

interface AirglowError extends Error {
  name: 'AirglowError';
  code?: string;
  status?: number;
  requestId?: string;
  details?: any;
}

interface AirglowFetchResponse<T = any> {
  status: number;
  ok: boolean;
  json(): Promise<T>;
  text(): Promise<string>;
}

interface AirglowWindowOptions {
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  popup?: boolean;
}

interface AirglowCaptureResult {
  base64: string;
  mediaType: 'image/jpeg';
}

interface AirglowConnectorOptions {
  /**
   * Account label distinguishing multiple identities on the same service
   * (e.g. two Google accounts). Use the account's email when targeting a
   * specific identity. Default: "default".
   */
  account?: string;
}

interface AirglowExecuteResult<T = any> {
  data: T;
  successful: boolean;
  error: string | null;
}

/** One installed app, as returned by `airglow.listApps()`. */
interface AirglowAppSummary {
  id: string;
  name: string;
  description?: string;
  visibility?: 'public' | 'hidden';
}

/**
 * Third-party tools (Gmail, Notion, Google Sheets, …). Connections are scoped
 * to this app. Tool slugs and parameter schemas: `airglow toolkit help`.
 *
 * In server functions (server/*.ts) the same `airglow.connectors` global is
 * available with execute/status/disconnect; connect() is client-only (it
 * opens the OAuth popup).
 */
interface AirglowConnectors {
  /** Ensure an active connection; opens the OAuth popup if needed and resolves once approved. */
  connect(toolkit: string, opts?: AirglowConnectorOptions): Promise<{ toolkit: string; connected: boolean }>;
  status(toolkit: string, opts?: AirglowConnectorOptions): Promise<{ connected: boolean }>;
  disconnect(toolkit: string, opts?: AirglowConnectorOptions): Promise<void>;
  /** Execute one tool, e.g. execute('GMAIL_FETCH_EMAILS', { query: 'from:uber.com' }). */
  execute<T = any>(tool: string, args?: Record<string, any>, opts?: AirglowConnectorOptions): Promise<AirglowExecuteResult<T>>;
}

/** One choice of a chat-completions response. */
interface AirglowLlmChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    /** Web-plugin citations (url_citation annotations). */
    annotations?: Record<string, any>[];
    [key: string]: any;
  };
  finish_reason: string | null;
  [key: string]: any;
}

/** OpenAI-style chat-completions response, returned unchanged by the gateway. */
interface AirglowChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: AirglowLlmChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; [key: string]: any };
  [key: string]: any;
}

/**
 * LLM access through the Airglow gateway — no app-side API key needed.
 * Available in every context, including server functions.
 */
interface AirglowLlm {
  /**
   * OpenAI chat-completions schema, proxied to OpenRouter. `payload` is the
   * request body, passed through unchanged. Allowed models:
   * `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-5` (default),
   * `anthropic/claude-opus-4.8`.
   *
   *   await airglow.llm.chat({
   *     model: 'anthropic/claude-sonnet-5', max_tokens: 1024,
   *     messages: [{ role: 'user', content: 'Hello' }],
   *   });
   *
   * Web search / fetch: add server tools — `tools: [{ type:
   * 'openrouter:web_search' }, { type: 'openrouter:web_fetch' }]` — and the
   * model searches (0-N times, choosing its own queries) and fetches URLs as
   * it sees fit, server-side. Citations arrive in `message.annotations`.
   * Alternative: `plugins: [{ id: 'web' }]` runs one search up front on every
   * call (the model has no say). Either form gets a longer timeout.
   *
   * Tools: standard OpenAI `tools` / `tool_choice`; the model returns
   * `message.tool_calls`, you run them and send `role: 'tool'` messages back
   * on the next call.
   *
   * Streaming: pass `{ onEvent }` as a second argument to observe the call's
   * progress while it runs. `onEvent` receives every raw stream chunk
   * (`choices[].delta`); the promise still resolves with the same complete
   * completion as the non-streaming call. Caveat: `tool_calls[].function
   * .arguments` stream as string fragments — only complete when the chunk
   * carrying that choice's `finish_reason` arrives.
   *
   *   const res = await airglow.llm.chat(payload, {
   *     onEvent: (c) => appendText(c.choices?.[0]?.delta?.content ?? ''),
   *   });
   */
  chat(payload: Record<string, any> & {
    model?: string;
    messages: { role: string; content: any; [key: string]: any }[];
    plugins?: Record<string, any>[];
  }, opts?: {
    /** Called with each raw stream chunk as the call streams. */
    onEvent?: (chunk: Record<string, any>) => void;
  }): Promise<AirglowChatCompletion>;
}

interface Airglow {
  sdkVersion: AirglowSdkVersion;

  connectors: AirglowConnectors;

  llm: AirglowLlm;

  fetch<T = any>(
    url: string,
    opts?: RequestInit & { includeCookies?: boolean },
  ): Promise<AirglowFetchResponse<T>>;

  storage: {
    get<T = any>(key: string): Promise<T | undefined>;
    set(key: string, value: any): Promise<void>;
    delete(key: string): Promise<void>;
    list(): Promise<string[]>;
  };

  log: {
    info(message: string, data?: any): Promise<void>;
    warn(message: string, data?: any): Promise<void>;
    error(message: string, data?: any): Promise<void>;
  };

  rpc<T = any>(functionName: string, payload?: any): Promise<T>;

  identity: {
    getRedirectURL(): Promise<string>;
    launchWebAuthFlow(url: string): Promise<string>;
  };

  openWindow(url: string, opts?: AirglowWindowOptions): Promise<void>;
  openWindowAndWaitClose(url: string, opts?: AirglowWindowOptions): Promise<void>;

  /** Open a URL as a new tab in the current browser window. */
  openTab(url: string, opts?: { active?: boolean }): Promise<void>;

  /**
   * Open an installed app inside the dashboard. Works from any context (app UI,
   * userscript) — the background resolves the extension URL, so callers never
   * hardcode the extension id. `opts.page` selects the app's sub-page (surfaced
   * to its UI as `__airglow_params.page`); `opts.window` opens a focused popup
   * window (size via `width`/`height`) instead of reusing the dashboard tab.
   */
  openApp(appId: string, opts?: { page?: string; window?: boolean; width?: number; height?: number }): Promise<void>;
  /**
   * Open the extension dashboard, optionally at a specific view. Embedded app
   * UIs only — a no-op elsewhere.
   */
  openDashboard(target?: { page?: 'apps' | 'catalog' | 'logs' | 'settings' }): void;
  /**
   * List installed apps the dashboard knows about. Embedded app UIs only —
   * resolves to `[]` outside the dashboard iframe.
   */
  listApps(): Promise<AirglowAppSummary[]>;

  captureTab(): Promise<AirglowCaptureResult>;

  /**
   * Read one cookie (by `name`) from the browser's real cookie jar for `url`'s
   * domain — including HttpOnly cookies `document.cookie` can't see — or `null`
   * if absent. Pairs with `fetch({ includeCookies: true })` for authenticated
   * cross-site reads that need a double-submit header whose value must equal a
   * cookie (e.g. an X csrf token that must match the `ct0` cookie).
   */
  getCookie(url: string, name: string): Promise<string | null>;

  platform: {
    allowIframes(domains: string[], initiators?: string[]): Promise<void>;
  };
}

declare const airglow: Airglow;

declare module '*.svg' {
  const content: string;
  export default content;
}
