// Shared feedback plumbing for the extension surfaces (dashboard + sidepanel).
// The UI lives in components/FeedbackModal.tsx; this module owns the visitor
// id, endpoint resolution, and the POST itself so both surfaces stay in sync.

import { normalizeUserEmail, USER_EMAIL_KEY } from './airglow-identity';
import { getCloudApiUrl } from './cloud-api';

const FEEDBACK_VISITOR_ID_KEY = '__airglow_feedback_visitor_id';
const FEEDBACK_TIMEOUT_MS = 8000;

export type FeedbackKind = 'general' | 'bug' | 'idea';
export type FeedbackStatus = { type: 'info' | 'success' | 'error'; text: string };

type PublicRuntimeConfig = {
  appServerUrl?: string;
  enableFeedback?: boolean;
  feedbackEndpoint?: string;
};

// Identifies the calling surface so feedback rows are attributable.
export type FeedbackSource = {
  appId: string;
  appName: string;
  sourceType: string;
};

async function getFeedbackVisitorId(): Promise<string> {
  const stored = await chrome.storage.local.get(FEEDBACK_VISITOR_ID_KEY);
  const existing = typeof stored[FEEDBACK_VISITOR_ID_KEY] === 'string' ? stored[FEEDBACK_VISITOR_ID_KEY] : '';
  if (existing) return existing;
  const next = crypto.randomUUID();
  await chrome.storage.local.set({ [FEEDBACK_VISITOR_ID_KEY]: next });
  return next;
}

async function getFeedbackEndpoint(): Promise<string> {
  const baseUrl = await getCloudApiUrl();
  const fallbackEndpoint = new URL('/api/feedback', `${baseUrl}/`).toString();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/config`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    });
  } catch {
    return fallbackEndpoint;
  }
  if (!res.ok) return fallbackEndpoint;

  let config: PublicRuntimeConfig;
  try {
    config = await res.json() as PublicRuntimeConfig;
  } catch {
    return fallbackEndpoint;
  }
  if (config.enableFeedback === false) throw new Error('Feedback is disabled.');

  const endpoint = config.feedbackEndpoint || '/api/feedback';
  const endpointBase = (config.appServerUrl || baseUrl).replace(/\/+$/, '');
  return new URL(endpoint, `${endpointBase}/`).toString();
}

// POSTs the feedback; throws on any non-2xx or transport failure.
export async function sendFeedback(kind: FeedbackKind, message: string, source: FeedbackSource): Promise<void> {
  const visitorId = await getFeedbackVisitorId();
  const endpoint = await getFeedbackEndpoint();
  const stored = await chrome.storage.local.get([USER_EMAIL_KEY]);
  const userEmail = normalizeUserEmail(stored[USER_EMAIL_KEY]);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      visitorId,
      userEmail,
      kind,
      message,
      appId: source.appId,
      appName: source.appName,
      sourceType: source.sourceType,
    }),
    signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
  });

  if (!res.ok) {
    let detail = `Feedback HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.error === 'string') detail = body.error;
    } catch {}
    throw new Error(detail);
  }
}
