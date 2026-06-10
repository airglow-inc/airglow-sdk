export const SIDEPANEL_DRAFTS_KEY = '__airglow_sidepanel_app_drafts';
export const SIDEPANEL_LAST_DRAFT_KEY = '__airglow_sidepanel_last_draft';

export interface SidePanelTargetTab {
  id: number;
  windowId: number;
  title?: string;
  url?: string;
  favIconUrl?: string;
  status?: string;
}

export type ConsentLevel = 'allowed' | 'disclosure' | 'approval';

export type BrowserActionKey =
  | 'read_current_tab_metadata'
  | 'capture_semantic_fingerprint'
  | 'dom_query'
  | 'screenshot_selected_tab'
  | 'switch_tab'
  | 'open_tab'
  | 'close_tab'
  | 'reload_tab'
  | 'navigate_tab'
  | 'click_page'
  | 'type_page'
  | 'submit_form'
  | 'scroll_page'
  | 'run_live_code'
  | 'attach_network_capture'
  | 'write_storage'
  | 'publish_app';

export interface ConsentPolicyResult {
  action: BrowserActionKey;
  level: ConsentLevel;
  label: string;
}

export interface AppDraftReview {
  readOnly: ConsentPolicyResult[];
  disclosures: ConsentPolicyResult[];
  approvals: ConsentPolicyResult[];
}

export interface SavedAppCloudMetadata {
  appId: string;
  appKey?: string;
  versionKey?: string;
  url?: string;
  requestId?: string;
  registered?: boolean;
  userScriptsEnabled?: boolean;
  generatedSummary?: string;
  generator?: string;
}

export interface SavedAppFallbackReason {
  message: string;
  code?: string;
  status?: number;
  requestId?: string;
}

export interface AirglowAppDraftPersistence {
  mode: 'cloud' | 'local';
  savedAt: string;
  cloud?: SavedAppCloudMetadata;
  fallbackReason?: SavedAppFallbackReason;
}

export interface AirglowAppDraft {
  id: string;
  name: string;
  prompt: string;
  messages: SidePanelChatMessage[];
  revision: number;
  target: SidePanelTargetTab | null;
  requestedActions: BrowserActionKey[];
  review: AppDraftReview;
  status: 'draft' | 'saved';
  createdAt: string;
  updatedAt: string;
  persistence?: AirglowAppDraftPersistence;
}

export interface CreateAirglowAppDraftInput {
  prompt: string;
  target?: SidePanelTargetTab | null;
  now?: Date;
  nonce?: string;
}

export interface SidePanelChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface AppendDraftUserMessageInput {
  content: string;
  now?: Date;
  nonce?: string;
}

export interface PrivateAppSavePayload {
  schemaVersion: 1;
  clientRequestId: string;
  draftId: string;
  name: string;
  prompt: string;
  conversation: Array<{
    role: SidePanelChatMessage['role'];
    content: string;
    createdAt: string;
  }>;
  previousApp?: {
    appId: string;
    versionKey?: string;
    generatedSummary?: string;
  };
  requestedActions: BrowserActionKey[];
  review: AppDraftReview;
  target: {
    title?: string;
    url?: string;
    origin?: string;
  } | null;
  clientCreatedAt: string;
  clientUpdatedAt: string;
  source: 'extension-sidepanel';
}

export interface MarkDraftSavedOptions {
  now?: Date;
  persistence?: Omit<AirglowAppDraftPersistence, 'savedAt'>;
  assistantMessage?: string;
}

const ACTION_LABELS: Record<BrowserActionKey, string> = {
  read_current_tab_metadata: 'Read the selected tab URL, title, and viewport metadata.',
  capture_semantic_fingerprint: 'Read visible page structure, labels, buttons, forms, and selector metadata.',
  dom_query: 'Read matching elements in the selected tab without changing the page.',
  screenshot_selected_tab: 'Use a screenshot of the selected tab for visual context.',
  switch_tab: 'Switch the active tab or focus a different window.',
  open_tab: 'Open a new tab or window.',
  close_tab: 'Close a tab or window.',
  reload_tab: 'Reload the selected tab.',
  navigate_tab: 'Navigate a tab to a new URL.',
  click_page: 'Click on the live page.',
  type_page: 'Type into the live page.',
  submit_form: 'Submit a form or send data from the live page.',
  scroll_page: 'Scroll the live page.',
  run_live_code: 'Run generated code against the live page.',
  attach_network_capture: 'Attach network capture to the selected tab.',
  write_storage: 'Write browser storage, cookies, clipboard, or downloads.',
  publish_app: 'Publish or share the app outside your private Airglow space.',
};

const DISCLOSURE_ACTIONS = new Set<BrowserActionKey>([
  'screenshot_selected_tab',
]);

const APPROVAL_ACTIONS = new Set<BrowserActionKey>([
  'switch_tab',
  'open_tab',
  'close_tab',
  'reload_tab',
  'navigate_tab',
  'click_page',
  'type_page',
  'submit_form',
  'scroll_page',
  'run_live_code',
  'attach_network_capture',
  'write_storage',
  'publish_app',
]);

export function consentPolicyForAction(action: BrowserActionKey): ConsentPolicyResult {
  const level: ConsentLevel = APPROVAL_ACTIONS.has(action)
    ? 'approval'
    : DISCLOSURE_ACTIONS.has(action)
      ? 'disclosure'
      : 'allowed';
  return { action, level, label: ACTION_LABELS[action] };
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

export function classifyPromptActions(prompt: string): BrowserActionKey[] {
  const lower = prompt.toLowerCase();
  const actions = new Set<BrowserActionKey>([
    'read_current_tab_metadata',
    'capture_semantic_fingerprint',
    'dom_query',
  ]);

  if (hasAny(lower, ['screenshot', 'screen shot', 'visual', 'image', 'look at the page'])) {
    actions.add('screenshot_selected_tab');
  }
  if (hasAny(lower, ['switch tab', 'focus tab', 'activate tab', 'different tab'])) {
    actions.add('switch_tab');
  }
  if (hasAny(lower, ['open tab', 'new tab', 'new window'])) {
    actions.add('open_tab');
  }
  if (hasAny(lower, ['close tab', 'close window'])) {
    actions.add('close_tab');
  }
  if (hasAny(lower, ['reload', 'refresh page'])) {
    actions.add('reload_tab');
  }
  if (hasAny(lower, ['navigate', 'go to ', 'open url', 'visit '])) {
    actions.add('navigate_tab');
  }
  if (hasAny(lower, ['click', 'press button', 'tap '])) {
    actions.add('click_page');
  }
  if (hasAny(lower, ['type ', 'fill ', 'enter text', 'write into'])) {
    actions.add('type_page');
  }
  if (hasAny(lower, ['submit', 'send form', 'checkout', 'book it'])) {
    actions.add('submit_form');
  }
  if (hasAny(lower, ['scroll'])) {
    actions.add('scroll_page');
  }
  if (hasAny(lower, ['network', 'api trace', 'capture requests'])) {
    actions.add('attach_network_capture');
  }
  if (hasAny(lower, ['save cookie', 'write storage', 'clipboard', 'download'])) {
    actions.add('write_storage');
  }

  return Array.from(actions);
}

export function buildDraftReview(actions: BrowserActionKey[]): AppDraftReview {
  const unique = Array.from(new Set(actions));
  const policies = unique.map(consentPolicyForAction);
  return {
    readOnly: policies.filter((policy) => policy.level === 'allowed'),
    disclosures: policies.filter((policy) => policy.level === 'disclosure'),
    approvals: policies.filter((policy) => policy.level === 'approval'),
  };
}

function titleCase(words: string[]): string {
  return words
    .map((word) => word ? word[0].toUpperCase() + word.slice(1) : word)
    .join(' ');
}

export function deriveAppName(prompt: string): string {
  const cleaned = prompt
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'New Airglow App';
  const words = cleaned.split(' ').slice(0, 5);
  return titleCase(words);
}

export function createAppDraft(input: CreateAirglowAppDraftInput): AirglowAppDraft {
  const prompt = input.prompt.trim().slice(0, 4000);
  const now = input.now ?? new Date();
  const iso = now.toISOString();
  const nonce = input.nonce ?? String(now.getTime());
  const requestedActions = classifyPromptActions(prompt);
  return {
    id: `draft-${nonce}`,
    name: deriveAppName(prompt),
    prompt,
    messages: [{
      id: `msg-${nonce}`,
      role: 'user',
      content: prompt,
      createdAt: iso,
    }],
    revision: 1,
    target: input.target ?? null,
    requestedActions,
    review: buildDraftReview(requestedActions),
    status: 'draft',
    createdAt: iso,
    updatedAt: iso,
  };
}

export function normalizeDraftForSave(draft: AirglowAppDraft, now: Date = new Date()): AirglowAppDraft {
  const fallbackPrompt = typeof draft.prompt === 'string' ? draft.prompt.trim().slice(0, 4000) : '';
  const fallbackCreatedAt = typeof draft.createdAt === 'string' ? draft.createdAt : now.toISOString();
  const rawMessages = Array.isArray(draft.messages) ? draft.messages : [];
  const messages = rawMessages
    .map((message, index): SidePanelChatMessage | null => {
      if (!message || typeof message !== 'object') return null;
      const record = message as Record<string, unknown>;
      const role = record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : null;
      const content = typeof record.content === 'string' ? record.content.trim().slice(0, 4000) : '';
      if (!role || !content) return null;
      return {
        id: typeof record.id === 'string' && record.id ? record.id : `msg-${role}-${index}`,
        role,
        content,
        createdAt: typeof record.createdAt === 'string' && record.createdAt ? record.createdAt : fallbackCreatedAt,
      };
    })
    .filter((message): message is SidePanelChatMessage => Boolean(message))
    .slice(-24);
  const normalizedMessages = messages.length > 0
    ? messages
    : [{
        id: 'msg-migrated-user',
        role: 'user' as const,
        content: fallbackPrompt || 'Create an Airglow app.',
        createdAt: fallbackCreatedAt,
      }];
  const latestUserMessage = [...normalizedMessages].reverse().find((message) => message.role === 'user');
  const prompt = latestUserMessage?.content || fallbackPrompt || normalizedMessages[normalizedMessages.length - 1].content;
  const requestedActions = classifyPromptActions(normalizedMessages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n'));
  return {
    ...draft,
    prompt,
    messages: normalizedMessages,
    revision: Number.isInteger(draft.revision) && draft.revision > 0 ? draft.revision : normalizedMessages.length,
    requestedActions,
    review: buildDraftReview(requestedActions),
  };
}

export function appendDraftUserMessage(draft: AirglowAppDraft, input: AppendDraftUserMessageInput): AirglowAppDraft {
  const content = input.content.trim().slice(0, 4000);
  if (!content) return draft;
  const normalizedDraft = normalizeDraftForSave(draft, input.now);
  const now = input.now ?? new Date();
  const iso = now.toISOString();
  const nonce = input.nonce ?? String(now.getTime());
  const messages = [
    ...normalizedDraft.messages,
    {
      id: `msg-${nonce}`,
      role: 'user' as const,
      content,
      createdAt: iso,
    },
  ].slice(-24);
  const requestedActions = classifyPromptActions(messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n'));
  return {
    ...normalizedDraft,
    prompt: content,
    messages,
    revision: normalizedDraft.revision + 1,
    requestedActions,
    review: buildDraftReview(requestedActions),
    status: 'draft',
    updatedAt: iso,
  };
}

export function buildPrivateAppSavePayload(draft: AirglowAppDraft, clientRequestId: string): PrivateAppSavePayload {
  const normalizedDraft = normalizeDraftForSave(draft);
  const previousApp = previousAppForPayload(normalizedDraft);
  return {
    schemaVersion: 1,
    clientRequestId,
    draftId: normalizedDraft.id,
    name: normalizedDraft.name,
    prompt: normalizedDraft.prompt,
    conversation: normalizedDraft.messages.map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })),
    ...(previousApp ? { previousApp } : {}),
    requestedActions: [...normalizedDraft.requestedActions],
    review: normalizedDraft.review,
    target: sanitizedTarget(normalizedDraft.target),
    clientCreatedAt: normalizedDraft.createdAt,
    clientUpdatedAt: normalizedDraft.updatedAt,
    source: 'extension-sidepanel',
  };
}

export function markDraftSaved(
  draft: AirglowAppDraft,
  optionsOrNow: MarkDraftSavedOptions | Date = {},
): AirglowAppDraft {
  const options = optionsOrNow instanceof Date ? { now: optionsOrNow } : optionsOrNow;
  const now = options.now ?? new Date();
  const savedAt = now.toISOString();
  const messages = options.assistantMessage
    ? [
        ...draft.messages,
        {
          id: `msg-saved-${savedAt}`,
          role: 'assistant' as const,
          content: options.assistantMessage.trim().slice(0, 4000),
          createdAt: savedAt,
        },
      ].slice(-24)
    : draft.messages;
  return {
    ...draft,
    messages,
    status: 'saved',
    updatedAt: savedAt,
    ...(options.persistence
      ? {
          persistence: {
            ...options.persistence,
            savedAt,
          },
        }
      : {}),
  };
}

function previousAppForPayload(draft: AirglowAppDraft): PrivateAppSavePayload['previousApp'] | undefined {
  if (draft.persistence?.mode !== 'cloud' || !draft.persistence.cloud?.appId) return undefined;
  return {
    appId: draft.persistence.cloud.appId,
    ...(draft.persistence.cloud.versionKey ? { versionKey: draft.persistence.cloud.versionKey } : {}),
    ...(draft.persistence.cloud.generatedSummary ? { generatedSummary: draft.persistence.cloud.generatedSummary } : {}),
  };
}

export function formatCloudSaveFallbackNotice(reason: SavedAppFallbackReason): string {
  const message = reason.message || 'Cloud save is unavailable.';
  if (
    reason.code === 'AIRGLOW_IDENTITY_UPSTREAM_ERROR' &&
    /anonymous sign-ins are disabled/i.test(message)
  ) {
    return 'Draft saved on this browser only. Airglow Cloud sign-in is not enabled yet, so this app cannot sync or run yet.';
  }
  if (
    reason.code === 'AIRGLOW_IDENTITY_NOT_CONFIGURED' ||
    reason.code === 'IDENTITY_NOT_CONFIGURED' ||
    reason.code === 'AIRGLOW_IDENTITY_SESSION_FAILED' ||
    reason.status === 503
  ) {
    return 'Draft saved on this browser only. Airglow Cloud sign-in is temporarily unavailable, so this app cannot sync or run yet.';
  }
  if (reason.status === 401) {
    return 'Draft saved on this browser only. Airglow Cloud could not verify this browser session, so this app cannot sync or run yet.';
  }
  if (reason.status === 404) {
    return 'Draft saved on this browser only. This Airglow Cloud server does not support private app save yet.';
  }
  if (reason.code === 'SAVE_APP_TIMEOUT') {
    return 'Draft saved on this browser only. Cloud generation took too long to finish, so this app cannot sync or run yet.';
  }
  return `Draft saved on this browser only. Cloud save failed: ${message}`;
}

function sanitizedTarget(target: SidePanelTargetTab | null): PrivateAppSavePayload['target'] {
  if (!target) return null;
  const next = {
    ...(target.title ? { title: target.title } : {}),
    ...(target.url ? { url: target.url } : {}),
    ...targetOrigin(target.url),
  };
  return Object.keys(next).length > 0 ? next : null;
}

function targetOrigin(url: string | undefined): { origin?: string } {
  if (!url) return {};
  try {
    return { origin: new URL(url).origin };
  } catch {
    return {};
  }
}
