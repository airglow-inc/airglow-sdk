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

type AirglowAnalyticsValue = string | number | boolean | null | string[];

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

  analytics: {
    used(action: string, properties?: Record<string, AirglowAnalyticsValue>): Promise<void>;
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
