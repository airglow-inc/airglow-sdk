/**
 * Helpers for managing the offscreen document that runs sandboxed app code.
 * Used for both startup scripts and local-execution RPC bundles.
 */

const OFFSCREEN_READY_TIMEOUT_MS = 2000;
const OFFSCREEN_READY_RETRY_MS = 50;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || '');
  }
  return String(error || '');
}

export function isExistingOffscreenDocumentError(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes('already exists') || message.includes('Only a single offscreen document may be created');
}

export function isMissingOffscreenReceiverError(message: string | undefined): boolean {
  return /Receiving end does not exist|Could not establish connection/i.test(message || '');
}

function isDeliveredWithoutResponseError(message: string | undefined): boolean {
  return /message port closed before a response was received/i.test(message || '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureAirglowOffscreenDocument(justification: string): Promise<void> {
  try {
    await (chrome.offscreen as any).createDocument({
      url: 'startup-runner.html',
      reasons: ['DOM_PARSER'] as any,
      justification,
    });
  } catch (error) {
    if (!isExistingOffscreenDocumentError(error)) throw error;
  }
}

/**
 * Retries chrome.runtime.sendMessage while the offscreen receiver is still
 * spinning up. Without this, the first message racing the receiver registration
 * fails with "Receiving end does not exist".
 */
export async function sendRuntimeMessageWhenReady(message: unknown): Promise<void> {
  const started = Date.now();
  let lastError: string | undefined;

  while (Date.now() - started <= OFFSCREEN_READY_TIMEOUT_MS) {
    const delivered = await new Promise<boolean>((resolve) => {
      chrome.runtime.sendMessage(message, () => {
        const error = chrome.runtime.lastError?.message;
        lastError = error;
        resolve(!error || isDeliveredWithoutResponseError(error));
      });
    });

    if (delivered) return;
    if (!isMissingOffscreenReceiverError(lastError)) break;
    await sleep(OFFSCREEN_READY_RETRY_MS);
  }

  throw new Error(lastError || 'offscreen runtime did not accept message');
}
