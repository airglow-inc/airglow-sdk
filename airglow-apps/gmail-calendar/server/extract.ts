import Anthropic from '@anthropic-ai/sdk';
import { Composio } from '@composio/core';

// --- Composio helpers (self-contained, no platform imports) ---

function userIdForEmail(email: string): string {
  return `airglow-gmail-${email.trim().toLowerCase()}`;
}

let _client: InstanceType<typeof Composio> | null = null;

function getClient(): InstanceType<typeof Composio> {
  if (!_client) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set');
    _client = new Composio({ apiKey });
  }
  return _client;
}

async function getConnectionEmail(userId: string): Promise<string | undefined> {
  try {
    const c = getClient();
    const result = await c.tools.execute('GMAIL_GET_PROFILE', {
      userId,
      arguments: { user_id: 'me' },
      dangerouslySkipVersionCheck: true,
    });
    const data = (result as any)?.data || result;
    return data?.emailAddress || data?.response_data?.emailAddress || undefined;
  } catch {
    return undefined;
  }
}

async function getGmailConnectionInfoForEmail(
  email: string,
): Promise<{ connected: boolean; email?: string }> {
  if (!email) return { connected: false };
  try {
    const c = getClient();
    const userId = userIdForEmail(email);
    const accounts = await c.connectedAccounts.list({
      userIds: [userId],
      toolkitSlugs: ['gmail'],
    });
    const active = (accounts.items ?? []).find((a: any) => a.status === 'ACTIVE');
    if (!active) return { connected: false };
    const confirmedEmail = await getConnectionEmail(userId);
    if (confirmedEmail && confirmedEmail.toLowerCase() !== email.toLowerCase()) {
      return { connected: false, email: confirmedEmail };
    }
    return { connected: true, email: confirmedEmail || email };
  } catch {
    return { connected: false };
  }
}

async function initiateGmailOAuthForEmail(email: string): Promise<{
  redirectUrl: string | null;
  connectionId: string;
}> {
  const c = getClient();
  const userId = userIdForEmail(email);
  const req = await c.toolkits.authorize(userId, 'gmail');
  return { redirectUrl: req.redirectUrl ?? null, connectionId: req.id };
}

async function fetchGmailMessageByIdForEmail(email: string, messageId: string): Promise<any> {
  const c = getClient();
  return c.tools.execute('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', {
    userId: userIdForEmail(email),
    arguments: { message_id: messageId, user_id: 'me' },
    dangerouslySkipVersionCheck: true,
  });
}

// --- Message parsing ---

function unwrap(raw: any): any {
  return raw?.data?.response_data ?? raw?.data ?? raw ?? {};
}

function parseMessage(raw: any): {
  subject: string;
  from: string;
  to: string;
  cc: string;
  body: string;
} {
  const d = unwrap(raw);
  return {
    subject: d.subject ?? d.Subject ?? '',
    from: d.sender ?? d.from ?? d.From ?? '',
    to: d.to ?? d.To ?? '',
    cc: d.cc ?? d.Cc ?? '',
    body: d.messageText ?? d.message_text ?? d.body ?? d.plain_text ?? d.snippet ?? '',
  };
}

// --- Main handler ---

export default async function extract(body: { messageId?: string; userEmail?: string }) {
  const { messageId, userEmail } = body;

  if (!messageId) return { ok: false, error: 'messageId is required' };
  if (!userEmail) return { ok: false, error: 'userEmail is required' };

  // Check Composio connection
  const conn = await getGmailConnectionInfoForEmail(userEmail);
  if (!conn.connected) {
    let authUrl: string | null = null;
    try {
      const oauth = await initiateGmailOAuthForEmail(userEmail);
      authUrl = oauth.redirectUrl;
      // Composio returns a short URL that 302s to Google OAuth.
      // Follow the redirect and append login_hint to pre-select the correct account.
      if (authUrl && userEmail) {
        try {
          const res = await fetch(authUrl, { redirect: 'manual' });
          const location = res.headers.get('location');
          if (location?.includes('accounts.google.com')) {
            authUrl = `${location}&login_hint=${encodeURIComponent(userEmail)}`;
          }
        } catch {}
      }
    } catch (e) {
      return { ok: false, error: `Composio OAuth init failed: ${String(e)}` };
    }
    return { ok: false, needsAuth: true, userEmail, authUrl };
  }

  // Fetch email via Composio
  let composioRaw: unknown;
  try {
    composioRaw = await fetchGmailMessageByIdForEmail(userEmail, messageId);
  } catch (e) {
    return { ok: false, error: `Composio fetch failed: ${String(e)}` };
  }

  const { subject, from, to, cc, body: emailBody } = parseMessage(composioRaw);
  if (!emailBody) {
    return { ok: false, error: 'Email body was empty after Composio fetch' };
  }

  const participants = [
    from && `from: ${from}`,
    to && `to: ${to}`,
    cc && `cc: ${cc}`,
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = `Extract meeting details from this email.

Email subject: ${subject}
User (do NOT include as guest): ${userEmail}
Participants:
${participants}

${emailBody}`;

  const schema = {
    type: 'object' as const,
    properties: {
      title: { type: 'string' as const, description: 'Concise meeting title, e.g. "Alice<>Bob"' },
      date: { type: 'string' as const, description: 'YYYY-MM-DD. Suggest next business day if not mentioned in email' },
      startTime: { type: 'string' as const, description: 'HH:MM 24h format. Default 14:00 if not mentioned' },
      endTime: { type: 'string' as const, description: 'HH:MM 24h format. Default 30 min after startTime' },
      guests: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: `Email addresses of guests from the participants list. NEVER include ${userEmail}.`,
      },
      location: { type: 'string' as const, description: 'Meeting location if mentioned, otherwise empty string' },
      description: { type: 'string' as const, description: 'One brief sentence about the meeting agenda, or empty string' },
    },
    required: ['title', 'date', 'startTime', 'endTime', 'guests', 'location', 'description'] as const,
    additionalProperties: false as const,
  };

  const model = 'claude-sonnet-4-6';
  const client = new Anthropic();

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      format: { type: 'json_schema', schema },
    },
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Log data passed back to client for storage in airglow.storage
  const _log = { model, subject, participants, prompt, raw: text };

  try {
    const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(jsonStr);
    return { ok: true, result, _log: { ..._log, result } };
  } catch {
    return { ok: false, error: 'Failed to parse LLM response', raw: text, _log };
  }
}
