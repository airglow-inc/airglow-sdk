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

/** One block of an Anthropic Messages response (text, tool_use, …). */
interface AirglowLlmContentBlock {
  type: string;
  text?: string;
  [key: string]: any;
}

/** Anthropic Messages API response, returned unchanged by the gateway. */
interface AirglowLlmMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AirglowLlmContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number; [key: string]: any };
  [key: string]: any;
}

/**
 * LLM access through the Airglow gateway — no app-side ANTHROPIC_API_KEY needed.
 * Available in every context, including server functions.
 */
interface AirglowLlm {
  anthropic: {
    /**
     * Anthropic Messages API. `payload` is the request body, passed through
     * unchanged. Allowed models: `claude-haiku-4-5`, `claude-sonnet-5`
     * (default), `claude-opus-4-8`.
     *
     * Set `web_search` to give the model live web search (Anthropic's hosted
     * web_search tool) — it researches before answering and cites sources.
     * The response `content` then includes `server_tool_use` /
     * `web_search_tool_result` blocks alongside the usual `text` blocks. Pass
     * `true` for defaults, or `{ max_uses?, allowed_domains?, blocked_domains? }`
     * to tune it (max_uses 1-10, default 5). Web-search calls get a higher
     * max_tokens ceiling and longer timeout; each search bills to the weekly
     * budget.
     *
     * Set `web_fetch` to let the model fetch URLs already present in the
     * conversation (Anthropic's hosted web_fetch tool — it never invents
     * URLs, so include the URL in your prompt). The response then includes
     * `server_tool_use` / `web_fetch_tool_result` blocks. Pass `true` for
     * defaults, or `{ max_uses?, allowed_domains?, blocked_domains?,
     * max_content_tokens? }` (max_uses 1-10, default 3; max_content_tokens
     * caps how much of a page enters the context — default 20000, max
     * 50000). Fetched content bills as ordinary input tokens; web-fetch
     * calls get the same higher max_tokens ceiling and longer timeout as
     * web search. Both params can be combined on one request.
     *
     * Pass `tools` (client tools `{ name, description?, input_schema }`) and
     * optional `tool_choice` to let the model call your functions: it returns
     * `tool_use` blocks, you run them and send `tool_result` blocks back on the
     * next call. Hosted/server tools are rejected — use the `web_search` /
     * `web_fetch` params instead.
     *
     *   await airglow.llm.anthropic.messages({
     *     model: 'claude-opus-4-8', max_tokens: 4000, web_search: true,
     *     messages: [{ role: 'user', content: 'Research Jane Doe, CEO of Acme.' }],
     *   });
     *
     * Streaming: pass `{ onEvent }` as a second argument to observe the call's
     * progress while it runs (e.g. show each web-search query as the model
     * issues it). `onEvent` receives every raw Anthropic SSE event
     * (`message_start`, `content_block_start`, `content_block_delta`,
     * `content_block_stop`, `message_delta`, `message_stop`); the promise still
     * resolves with the same complete message as the non-streaming call.
     * Caveat: a `server_tool_use` / `tool_use` block's `input` (e.g. the search
     * query) streams as `input_json_delta` fragments — it is only complete at
     * that block's `content_block_stop`; accumulate `partial_json` and parse
     * there.
     *
     *   const res = await airglow.llm.anthropic.messages(payload, {
     *     onEvent: (e) => { if (e.type === 'content_block_start') showProgress(e); },
     *   });
     */
    messages(payload: Record<string, any> & {
      web_search?: boolean | { max_uses?: number; allowed_domains?: string[]; blocked_domains?: string[] };
      web_fetch?: boolean | { max_uses?: number; allowed_domains?: string[]; blocked_domains?: string[]; max_content_tokens?: number };
    }, opts?: {
      /** Called with each raw Anthropic SSE event as the call streams. */
      onEvent?: (event: Record<string, any>) => void;
    }): Promise<AirglowLlmMessage>;
  };
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

  platform: {
    allowIframes(domains: string[], initiators?: string[]): Promise<void>;
  };
}

declare const airglow: Airglow;

declare module '*.svg' {
  const content: string;
  export default content;
}
