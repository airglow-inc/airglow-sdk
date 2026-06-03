/** Tool manifest — describes a single injectable tool */
export interface ToolManifest {
  id: string;
  name: string;
  description: string;
  /** URL patterns where this tool activates (Chrome match patterns) */
  matches: string[];
  /** Server base URL for API calls */
  serverUrl: string;
}

/** Message from background → content script or tool script */
export interface ToolMessage {
  type: 'inject-tool' | 'remove-tool';
  toolId: string;
  /** JS code to inject (for userScripts approach) */
  code?: string;
  /** Config data for the tool */
  config?: Record<string, unknown>;
}
