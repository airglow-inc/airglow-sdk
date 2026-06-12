export const SIDEPANEL_DRAFTS_KEY = '__airglow_sidepanel_app_drafts';
export const SIDEPANEL_LAST_DRAFT_KEY = '__airglow_sidepanel_last_draft';

export interface SidePanelTargetTab {
  id?: number;
  windowId?: number;
  title?: string;
  url?: string;
  matchPattern?: string;
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

export type SidePanelGenerationRunStatus =
  | 'queued'
  | 'planning'
  | 'waiting_for_user'
  | 'generating'
  | 'static_review'
  | 'validating'
  | 'browser_smoke'
  | 'repairing'
  | 'packaging'
  | 'publishing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SidePanelGenerationRunEventType =
  | 'assistant_message'
  | 'clarification_requested'
  | 'phase_started'
  | 'phase_completed'
  | 'warning'
  | 'completed'
  | 'failed';

export interface SidePanelGenerationRunEvent {
  sequence: number;
  type: SidePanelGenerationRunEventType;
  message: string;
  role?: 'assistant' | 'system';
  phase?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface SidePanelGenerationRunMetadata {
  runId: string;
  status: SidePanelGenerationRunStatus;
  lastSequence: number;
  startedAt: string;
  updatedAt: string;
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
  generationRun?: SidePanelGenerationRunMetadata;
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

export interface AppendDraftAssistantMessageInput {
  content: string;
  id?: string;
  createdAt?: string;
  now?: Date;
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
    matchPattern?: string;
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

export interface MarkDraftGenerationRunInput {
  runId: string;
  status: SidePanelGenerationRunStatus;
  lastSequence?: number;
  startedAt?: string;
  updatedAt?: string;
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

// Heal a draft read back from storage. Drafts persisted by older builds predate
// the `messages`/`generationRun` fields, so a restored draft can have
// `messages: undefined`. The sidepanel reads `draft?.messages.length` (the `?.`
// only guards `draft` being null, not `messages`), so an unhealed legacy draft
// throws "Cannot read properties of undefined (reading 'length')" and crashes
// the React mount — a blank panel. Normalizing here upholds the type contract
// (all array fields present) before the draft ever reaches the UI.
export function normalizeStoredDraft(raw: unknown): AirglowAppDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== 'string' || !d.id) return null;

  const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  const rawReview = d.review && typeof d.review === 'object' ? (d.review as Record<string, unknown>) : {};
  const review: AppDraftReview = {
    readOnly: asArray<ConsentPolicyResult>(rawReview.readOnly),
    disclosures: asArray<ConsentPolicyResult>(rawReview.disclosures),
    approvals: asArray<ConsentPolicyResult>(rawReview.approvals),
  };

  const createdAt = typeof d.createdAt === 'string' ? d.createdAt : new Date().toISOString();
  const prompt = typeof d.prompt === 'string' ? d.prompt : '';
  let messages = asArray<unknown>(d.messages).filter(
    (m): m is SidePanelChatMessage =>
      Boolean(m) && typeof m === 'object'
      && ((m as SidePanelChatMessage).role === 'user' || (m as SidePanelChatMessage).role === 'assistant')
      && typeof (m as SidePanelChatMessage).content === 'string',
  );
  // Legacy drafts have no messages but do carry the original prompt — surface it
  // as the first user message so the restored chat is not empty.
  if (messages.length === 0 && prompt.trim()) {
    messages = [{ id: `msg-${d.id}`, role: 'user', content: prompt, createdAt }];
  }

  return {
    id: d.id,
    name: typeof d.name === 'string' ? d.name : '',
    prompt,
    messages,
    revision: Number.isInteger(d.revision) ? (d.revision as number) : messages.length,
    target: d.target && typeof d.target === 'object' ? (d.target as SidePanelTargetTab) : null,
    requestedActions: asArray<BrowserActionKey>(d.requestedActions),
    review,
    status: d.status === 'saved' ? 'saved' : 'draft',
    createdAt,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : createdAt,
    ...(d.persistence && typeof d.persistence === 'object'
      ? { persistence: d.persistence as AirglowAppDraftPersistence }
      : {}),
    ...(d.generationRun && typeof d.generationRun === 'object'
      ? { generationRun: d.generationRun as SidePanelGenerationRunMetadata }
      : {}),
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

const EXPLICIT_WEB_TARGETS: Array<{ key: string; hosts: string[]; terms: RegExp[]; standaloneIntent?: RegExp }> = [
  {
    key: 'wikipedia',
    hosts: ['wikipedia.org'],
    terms: [/\bwikipedia(?:\.org)?\b/i, /википед[а-яё]*/i],
    standaloneIntent: /\b(?:summari[sz](?:e|er|ation)?|summary|саммар[а-яё]*|суммар[а-яё]*|резюм[а-яё]*|кратк[а-яё]*)\b/i,
  },
  { key: 'youtube', hosts: ['youtube.com'], terms: [/\byoutube(?:\.com)?\b/i, /ютуб[а-яё]*/i, /ютьюб[а-яё]*/i] },
  {
    key: 'codeforces',
    hosts: ['codeforces.com'],
    terms: [/\bcodeforces(?:\.com)?\b/i, /кодфорс[а-яё]*/i],
    standaloneIntent: /\b(?:solve|solver|solution|решател[а-яё]*|решени[а-яё]*|задач[а-яё]*|алгоритм[а-яё]*)\b/i,
  },
  {
    key: 'leetcode',
    hosts: ['leetcode.com'],
    terms: [/\bleet\s*code(?:\.com)?\b/i, /\bleetcode(?:\.com)?\b/i, /литкод[а-яё]*/i],
    standaloneIntent: /\b(?:solve|solver|solution|решател[а-яё]*|решени[а-яё]*|задач[а-яё]*|алгоритм[а-яё]*|insert|встав[а-яё]*)\b/i,
  },
];

const PROMPT_TARGET_PREFIX = String.raw`(?:for|on|at|inside|target(?:ing)?|для|на|в|под|сайт(?:е|а)?|страниц(?:е|ах|у|ы)?)`;
const DOMAIN_LABEL = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;
const DOMAIN_TEXT = String.raw`${DOMAIN_LABEL}(?:\.${DOMAIN_LABEL})+`;
const FILE_EXTENSION_SUFFIXES = new Set([
  'cjs',
  'css',
  'gif',
  'htm',
  'html',
  'jpeg',
  'jpg',
  'js',
  'json',
  'jsx',
  'map',
  'md',
  'mjs',
  'pdf',
  'png',
  'svg',
  'ts',
  'tsx',
  'txt',
  'webp',
]);

const NEW_APP_PATTERNS = [
  /^\s*(build|create|generate)\b/i,
  /^\s*make\s+(?:a|an|new)\b/i,
  /^\s*(сделай|создай|сгенерируй|собери|построй|запили)\b/i,
];

const REFINEMENT_PATTERNS = [
  /^\s*(add|remove|change|update|refine|fix|also|now)\b/i,
  /^\s*make\s+(?:it|this|the\s+(?:panel|button|text|ui))\b/i,
  /\b(smaller|bigger|larger|compact|red|blue|green|copy button)\b/i,
  /^\s*(добавь|убери|измени|поменяй|исправь|обнови|доработай|теперь|ещ[её])\b/i,
  /^\s*сделай\s+(?:его|ее|её|это|панель|кнопк[ауи]?|текст|цвет|размер)\b/i,
  /\b(компактн|меньше|больше|красн|син|зелен|зелён|кнопк[ауи]?\s+копир)\b/i,
];

export function promptHasExplicitWebTarget(prompt: string): boolean {
  return Boolean(explicitPromptTargetKey(prompt) || domainMentionFromPrompt(prompt));
}

export function draftHasExplicitWebTarget(draft: AirglowAppDraft): boolean {
  if (normalizeMatchPattern(draft.target?.matchPattern)) return true;
  return draft.messages.some((message) => message.role === 'user' && promptHasExplicitWebTarget(message.content));
}

export function promptRequestsCurrentPage(prompt: string): boolean {
  return (
    /\b(?:this|current|selected)\s+(?:page|tab|site)\b/i.test(prompt) ||
    /\b(?:page|tab)\s+(?:i'?m\s+)?(?:on|viewing|looking at)\b/i.test(prompt) ||
    /(?:^|[\s(])(?:эта|эту|этой|текущая|текущую|текущей|выбранная|выбранную|выбранной)\s+(?:страниц[а-яё]*|вкладк[а-яё]*|сайт[а-яё]*)(?=$|[\s),.!?:;])/i.test(prompt)
  );
}

export function draftRequestsCurrentPage(draft: AirglowAppDraft): boolean {
  return draft.messages.some((message) => message.role === 'user' && promptRequestsCurrentPage(message.content));
}

export function shouldStartNewAppDraftForPrompt(draft: AirglowAppDraft, prompt: string): boolean {
  const content = prompt.trim();
  if (!content) return false;
  const hasExistingWork = draft.messages.length > 0 || Boolean(draft.persistence);
  if (!hasExistingWork) return false;
  const explicitTargetKey = explicitPromptTargetKey(content) || domainMentionFromPrompt(content);
  if (explicitTargetKey) {
    const currentTargetKey = draftTargetKey(draft);
    if (!currentTargetKey || currentTargetKey !== explicitTargetKey) return true;
  }
  return looksLikeNewAppRequest(content) && !looksLikeRefinementRequest(content);
}

function looksLikeNewAppRequest(prompt: string): boolean {
  return NEW_APP_PATTERNS.some((pattern) => pattern.test(prompt));
}

function looksLikeRefinementRequest(prompt: string): boolean {
  return REFINEMENT_PATTERNS.some((pattern) => pattern.test(prompt));
}

function explicitPromptTargetKey(prompt: string): string | undefined {
  const explicit = EXPLICIT_WEB_TARGETS.find((target) => target.terms.some((term) => (
    targetMentionIsExplicit(prompt, term) || targetMentionLooksLikeAppTitle(prompt, term, target.standaloneIntent)
  )));
  return explicit?.key;
}

function draftTargetKey(draft: AirglowAppDraft): string | undefined {
  const hostname = normalizedHostname(draft.target?.url);
  if (hostname) return explicitTargetKeyForHostname(hostname) || hostname;
  const userMessages = draft.messages.filter((message) => message.role === 'user').map((message) => message.content);
  for (const message of userMessages) {
    const key = explicitPromptTargetKey(message) || domainMentionFromPrompt(message);
    if (key) return key;
  }
  return undefined;
}

function explicitTargetKeyForHostname(hostname: string): string | undefined {
  const explicit = EXPLICIT_WEB_TARGETS.find((target) => target.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)));
  return explicit?.key;
}

function targetMentionIsExplicit(prompt: string, term: RegExp): boolean {
  const match = term.exec(prompt);
  if (!match || match.index === undefined) return false;
  const before = prompt.slice(0, match.index);
  return new RegExp(String.raw`(?:^|[\s(])${PROMPT_TARGET_PREFIX}\s+(?:the\s+|сайт\s+)?$`, 'iu').test(before);
}

function targetMentionLooksLikeAppTitle(prompt: string, term: RegExp, standaloneIntent: RegExp | undefined): boolean {
  if (!standaloneIntent) return false;
  term.lastIndex = 0;
  const match = term.exec(prompt);
  if (!match || match.index === undefined) return false;
  const after = prompt.slice(match.index + match[0].length);
  standaloneIntent.lastIndex = 0;
  return /^\s+/.test(after) && standaloneIntent.test(after);
}

function domainMentionFromPrompt(prompt: string): string | undefined {
  const match = new RegExp(
    String.raw`(?:^|[\s(])${PROMPT_TARGET_PREFIX}\s+(?:https?:\/\/)?(${DOMAIN_TEXT})(?=$|[\/\s),.!?:;])`,
    'i',
  ).exec(prompt);
  return normalizedPromptHostname(match?.[1]);
}

function normalizedPromptHostname(value: string | undefined): string | undefined {
  const hostname = normalizedHostname(value);
  if (!hostname || !hostnameLooksLikeWebDomain(hostname)) return undefined;
  return explicitTargetKeyForHostname(hostname) || hostname;
}

function normalizedHostname(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function hostnameLooksLikeWebDomain(hostname: string): boolean {
  if (!/^[a-z0-9.-]+$/i.test(hostname) || hostname.includes('..')) return false;
  const labels = hostname.toLowerCase().split('.');
  if (labels.length < 2 || labels.some((label) => !label || label.startsWith('-') || label.endsWith('-'))) return false;
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,24}$/.test(tld) && !FILE_EXTENSION_SUFFIXES.has(tld);
}

function normalizeMatchPattern(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const pattern = value.trim();
  const match = /^(https?):\/\/([^/]+)\/\*$/.exec(pattern);
  if (!match) return undefined;
  const host = match[2];
  if (!host || host === '*' || host.includes(':') || host.includes('**')) return undefined;
  const hostname = host.startsWith('*.') ? host.slice(2) : host;
  if (!hostnameLooksLikeWebDomain(hostname)) return undefined;
  return pattern;
}

export function appendDraftAssistantMessage(
  draft: AirglowAppDraft,
  input: AppendDraftAssistantMessageInput,
): AirglowAppDraft {
  const content = input.content.trim().slice(0, 4000);
  if (!content) return draft;
  const normalizedDraft = normalizeDraftForSave(draft, input.now);
  const now = input.now ?? new Date();
  const createdAt = input.createdAt || now.toISOString();
  const id = input.id || `msg-assistant-${createdAt}`;
  if (normalizedDraft.messages.some((message) => message.id === id)) return normalizedDraft;
  return {
    ...normalizedDraft,
    messages: [
      ...normalizedDraft.messages,
      {
        id,
        role: 'assistant',
        content,
        createdAt,
      },
    ].slice(-24),
    updatedAt: createdAt,
  };
}

export function markDraftGenerationRun(
  draft: AirglowAppDraft,
  input: MarkDraftGenerationRunInput,
): AirglowAppDraft {
  const normalizedDraft = normalizeDraftForSave(draft);
  const nowIso = new Date().toISOString();
  const previous = normalizedDraft.generationRun;
  return {
    ...normalizedDraft,
    status: 'draft',
    updatedAt: input.updatedAt || nowIso,
    generationRun: {
      runId: input.runId,
      status: input.status,
      lastSequence: input.lastSequence ?? previous?.lastSequence ?? 0,
      startedAt: input.startedAt || previous?.startedAt || input.updatedAt || nowIso,
      updatedAt: input.updatedAt || nowIso,
    },
  };
}

export function applyGenerationRunEventsToDraft(
  draft: AirglowAppDraft,
  run: MarkDraftGenerationRunInput,
  events: SidePanelGenerationRunEvent[],
): AirglowAppDraft {
  const lastSequence = events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), run.lastSequence ?? 0);
  let next = markDraftGenerationRun(draft, {
    ...run,
    lastSequence,
    updatedAt: run.updatedAt || events[events.length - 1]?.createdAt,
  });
  for (const event of events) {
    if (!shouldRenderGenerationRunEventAsMessage(event)) continue;
    next = appendDraftAssistantMessage(next, {
      id: `msg-run-${run.runId}-${event.sequence}`,
      content: event.message,
      createdAt: event.createdAt,
    });
  }
  return next;
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
    generationRun: undefined,
  };
}

function shouldRenderGenerationRunEventAsMessage(event: SidePanelGenerationRunEvent): boolean {
  return (
    event.role === 'assistant' &&
    (
      event.type === 'assistant_message' ||
      event.type === 'clarification_requested' ||
      event.type === 'completed' ||
      event.type === 'failed' ||
      event.type === 'warning'
    )
  );
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
    ...(normalizeMatchPattern(target.matchPattern) ? { matchPattern: normalizeMatchPattern(target.matchPattern) } : {}),
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
