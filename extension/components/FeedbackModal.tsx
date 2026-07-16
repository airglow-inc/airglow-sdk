// Shared "Airglow feedback" modal used by both the dashboard and the
// sidepanel. Owns its own draft/status state; the host only toggles `open`.

import { type FormEvent, useState } from 'react';
import { Send, X } from 'lucide-react';
import { type FeedbackSource, type FeedbackStatus, sendFeedback } from '../lib/feedback';

export function FeedbackModal({ open, onClose, source }: { open: boolean; onClose: () => void; source: FeedbackSource }) {
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<FeedbackStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const trimmed = message.trim();
    if (trimmed.length < 3) {
      setStatus({ type: 'error', text: 'Add at least 3 characters.' });
      return;
    }
    setSubmitting(true);
    setStatus(null);
    try {
      await sendFeedback('general', trimmed, source);
      setStatus({ type: 'success', text: 'Sent. Thank you.' });
      setMessage('');
    } catch (error) {
      setStatus({ type: 'error', text: error instanceof Error ? error.message : 'Could not send feedback.' });
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end p-5"
      style={{ background: 'rgba(28,25,23,0.18)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="feedback-modal-backdrop"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-[420px] rounded-lg p-5 border"
        style={{
          background: 'var(--bg-white)',
          borderColor: 'var(--border-tertiary)',
          boxShadow: '0 16px 40px rgba(28,25,23,.18)',
          color: 'var(--fg-primary)',
        }}
        data-testid="feedback-modal"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="text-lg font-semibold" style={{ color: 'var(--fg-primary)' }}>Airglow feedback</div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md cursor-pointer inline-flex items-center justify-center"
            style={{ color: 'var(--fg-tertiary)', background: 'transparent', border: 0 }}
            aria-label="Close feedback"
          >
            <X size={18} />
          </button>
        </div>
        <textarea
          required
          minLength={3}
          maxLength={2000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Description"
          className="w-full min-h-[120px] p-3 text-base rounded-sm border outline-none resize-y"
          style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-primary)', color: 'var(--fg-primary)' }}
          data-testid="feedback-message"
          autoFocus
        />
        {status && (
          <div
            className="mt-2 text-sm"
            style={{
              color: status.type === 'error'
                ? 'var(--error)'
                : status.type === 'success'
                  ? 'var(--olive)'
                  : 'var(--fg-secondary)',
            }}
            data-testid="feedback-status"
          >
            {status.text}
          </div>
        )}
        <button
          type="submit"
          disabled={submitting || message.trim().length < 3}
          className="mt-3 h-9 px-4 rounded-md text-base font-medium transition-all border inline-flex items-center gap-2"
          style={{
            color: 'var(--bg-white)',
            borderColor: 'var(--clay)',
            background: 'var(--clay)',
            opacity: submitting || message.trim().length < 3 ? 0.45 : 1,
            cursor: submitting || message.trim().length < 3 ? 'not-allowed' : 'pointer',
          }}
          data-testid="feedback-submit"
        >
          <Send size={15} />
          {submitting ? 'Sending…' : 'Send feedback'}
        </button>
      </form>
    </div>
  );
}
