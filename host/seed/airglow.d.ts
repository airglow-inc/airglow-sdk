/** Airglow SDK - available globally in userscripts, UI, and startup code. */
type AirglowSdkVersion = '0.1.0-beta.1';

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
     * unchanged. Allowed models: `claude-haiku-4-5`, `claude-sonnet-4-6`
     * (default), `claude-opus-4-8`.
     */
    messages(payload: Record<string, any>): Promise<AirglowLlmMessage>;
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
