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

interface AirglowRedirectRule {
  domains: string[];
  target: string;
}

interface AirglowAnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AirglowAnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AirglowAnthropicTextBlock[];
}

interface AirglowAnthropicMessagesRequest {
  model?: string;
  max_tokens?: number;
  messages: AirglowAnthropicMessage[];
  system?: string | AirglowAnthropicTextBlock[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}

interface AirglowAnthropicMessagesResponse {
  id?: string;
  type?: string;
  role?: 'assistant';
  content?: any[];
  model?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: any;
  [key: string]: any;
}

interface Airglow {
  sdkVersion: AirglowSdkVersion;

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

  llm: {
    anthropic: {
      messages<T = AirglowAnthropicMessagesResponse>(
        payload: AirglowAnthropicMessagesRequest,
      ): Promise<T>;
    };
  };

  identity: {
    getRedirectURL(): Promise<string>;
    launchWebAuthFlow(url: string): Promise<string>;
    getUserEmail(): Promise<string | undefined>;
    setUserEmail(email: string): Promise<string | undefined>;
  };

  openWindow(url: string, opts?: AirglowWindowOptions): Promise<void>;
  openWindowAndWaitClose(url: string, opts?: AirglowWindowOptions): Promise<void>;

  /** Open a URL as a new tab in the current browser window. */
  openTab(url: string, opts?: { active?: boolean }): Promise<void>;

  captureTab(): Promise<AirglowCaptureResult>;

  platform: {
    registerRedirects(rules: AirglowRedirectRule[]): Promise<void>;
    allowIframes(domains: string[], initiators?: string[]): Promise<void>;
  };
}

declare const airglow: Airglow;

declare module '*.svg' {
  const content: string;
  export default content;
}
