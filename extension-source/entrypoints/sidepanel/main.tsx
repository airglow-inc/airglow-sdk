import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, ExternalLink, Loader2, RefreshCw, Save, Send, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import './style.css';
import {
  type AirglowAppDraft,
  type SidePanelTargetTab,
  appendDraftUserMessage,
  createAppDraft,
  formatCloudSaveFallbackNotice,
} from '../../lib/sidepanel-model';
import logoUrl from '../../lib/branding/logo.svg';

type TargetResponse = {
  target?: SidePanelTargetTab | null;
  error?: string;
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type ApplyState = 'idle' | 'applying' | 'applied' | 'error';

type SaveDraftResponse =
  | {
      ok: true;
      mode: 'cloud';
      draft: AirglowAppDraft;
      cloud: {
        appId: string;
        appKey?: string;
        versionKey?: string;
        requestId?: string;
        registered?: boolean;
        userScriptsEnabled?: boolean;
        generatedSummary?: string;
        generator?: string;
      };
    }
  | {
      ok: true;
      mode: 'local_fallback';
      draft: AirglowAppDraft;
      cloudError: {
        message: string;
        code?: string;
        status?: number;
        requestId?: string;
      };
    };

function sendRuntimeMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T & { error?: string }) => {
      const error = chrome.runtime.lastError?.message || response?.error;
      if (error) reject(new Error(error));
      else resolve(response);
    });
  });
}

function targetLabel(target: SidePanelTargetTab | null): string {
  if (!target) return 'No selected tab';
  if (target.title?.trim()) return target.title.trim();
  if (target.url) return target.url;
  return `Tab ${target.id}`;
}

function targetOrigin(target: SidePanelTargetTab | null): string {
  if (!target?.url) return 'Current browser context';
  try {
    return new URL(target.url).origin;
  } catch {
    return target.url;
  }
}

function ApprovalList({ draft }: { draft: AirglowAppDraft }) {
  const hasApprovals = draft.review.approvals.length > 0;
  return (
    <div className="review-grid">
      <section className="review-section">
        <div className="section-title">
          <ShieldCheck size={15} />
          <span>Reads without approval</span>
        </div>
        <ul>
          {draft.review.readOnly.map((item) => (
            <li key={item.action}>{item.label}</li>
          ))}
        </ul>
      </section>

      {draft.review.disclosures.length > 0 && (
        <section className="review-section notice">
          <div className="section-title">
              <Sparkles size={15} />
              <span>Shown before save</span>
          </div>
          <ul>
            {draft.review.disclosures.map((item) => (
              <li key={item.action}>{item.label}</li>
            ))}
          </ul>
        </section>
      )}

      <section className={hasApprovals ? 'review-section approval' : 'review-section'}>
        <div className="section-title">
          {hasApprovals ? <TriangleAlert size={15} /> : <Check size={15} />}
          <span>{hasApprovals ? 'Not added without approval' : 'No page automation detected'}</span>
        </div>
        {hasApprovals ? (
          <>
            <p>The generated app stays read-only for now. These actions need explicit approval before they can be added.</p>
            <ul>
              {draft.review.approvals.map((item) => (
                <li key={item.action}>{item.label}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>This app only needs passive reads in the selected tab so far.</p>
        )}
      </section>
    </div>
  );
}

function App() {
  const [target, setTarget] = useState<SidePanelTargetTab | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [loadingTarget, setLoadingTarget] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const [draft, setDraft] = useState<AirglowAppDraft | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [savedAppId, setSavedAppId] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);

  async function refreshTarget() {
    setLoadingTarget(true);
    setTargetError(null);
    try {
      const response = await sendRuntimeMessage<TargetResponse>({ type: 'airglow:sidepanel:get-target' });
      setTarget(response.target ?? null);
    } catch (error) {
      setTarget(null);
      setTargetError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTarget(false);
    }
  }

  useEffect(() => {
    refreshTarget();
  }, []);

  const canSend = chatInput.trim().length > 0 && !loadingTarget && saveState !== 'saving';

  const disclosureText = useMemo(() => {
    if (!target) return 'Select a browser tab to give Airglow page context.';
    return `Using the selected tab title, URL, and visible text for generation. The saved app can refresh read-only page text on ${targetOrigin(target)} after it is installed.`;
  }, [target]);

  async function saveDraftToCloud(draftToSave: AirglowAppDraft) {
    const wasUpdate = draftToSave.persistence?.mode === 'cloud';
    setSaveState('saving');
    setSaveError(null);
    setSaveNotice(null);
    try {
      const response = await sendRuntimeMessage<SaveDraftResponse>({
        type: 'airglow:sidepanel:save-draft',
        requestId: crypto.randomUUID(),
        draft: draftToSave,
      });
      setDraft(response.draft);
      if (response.mode === 'cloud') {
        setSavedAppId(response.cloud.appId);
        setSaveNotice(response.cloud.userScriptsEnabled === false
            ? `${wasUpdate ? 'Updated' : 'Generated'} and saved. Enable User Scripts in Chrome extension settings, then refresh the target page to show the on-page panel.`
            : response.cloud.registered
              ? `${wasUpdate ? 'Updated' : 'Generated'} and saved. Refresh the target page to show the on-page panel.`
              : `${wasUpdate ? 'Updated' : 'Generated'} and saved, but the page script is not registered yet. Reload Airglow, then refresh the target page.`);
      } else {
        setSavedAppId(null);
        setSaveNotice(formatCloudSaveFallbackNotice(response.cloudError));
      }
      setSaveState('saved');
      setApplyState('idle');
      setApplyError(null);
    } catch (error) {
      setSaveState('error');
      setSaveError(error instanceof Error ? error.message : String(error));
      setSavedAppId(null);
    }
  }

  async function handleSubmitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) return;
    const content = chatInput.trim();
    const nextDraft = draft
      ? appendDraftUserMessage(draft, { content, nonce: crypto.randomUUID() })
      : createAppDraft({
          prompt: content,
          target,
          nonce: crypto.randomUUID(),
        });
    setDraft(nextDraft);
    setChatInput('');
    setSaveState('idle');
    setSaveError(null);
    setSaveNotice(null);
    setApplyState('idle');
    setApplyError(null);
    await saveDraftToCloud(nextDraft);
  }

  async function handleSaveDraft() {
    if (!draft) return;
    await saveDraftToCloud(draft);
  }

  async function openSavedApp() {
    if (!savedAppId) return;
    await sendRuntimeMessage({ type: 'airglow:open-app', appId: savedAppId });
  }

  async function openDashboard() {
    await sendRuntimeMessage({ type: 'airglow:open-dashboard' });
  }

  async function refreshTargetPage() {
    const tabId = draft?.target?.id;
    if (typeof tabId !== 'number') return;
    setApplyState('applying');
    setApplyError(null);
    try {
      await sendRuntimeMessage({ type: 'airglow:sidepanel:reload-target', tabId, appId: savedAppId });
      setApplyState('applied');
    } catch (error) {
      setApplyState('error');
      setApplyError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="sidepanel">
      <header className="topbar">
        <img src={logoUrl} alt="" />
        <div>
          <h1>Airglow</h1>
          <p>Build apps for the selected page.</p>
        </div>
      </header>

      <section className="target-bar" aria-live="polite">
        <div>
          <span className="eyebrow">Target tab</span>
          <strong>{loadingTarget ? 'Reading selected tab...' : targetLabel(target)}</strong>
          <small>{targetError || targetOrigin(target)}</small>
        </div>
        <button type="button" className="icon-button" onClick={refreshTarget} disabled={loadingTarget} aria-label="Refresh target tab">
          {loadingTarget ? <Loader2 size={17} className="spin" /> : <RefreshCw size={17} />}
        </button>
      </section>

      <section className="chat-panel">
        <div className="chat-log" aria-live="polite">
          {draft?.messages.length ? draft.messages.map((message) => (
            <div key={message.id} className={`chat-message ${message.role}`}>
              <span>{message.role === 'user' ? 'You' : 'Airglow'}</span>
              <p>{message.content}</p>
            </div>
          )) : (
            <div className="chat-empty">
              <Sparkles size={17} />
              <p>Ask for an app for this page.</p>
            </div>
          )}
        </div>
        <form className="chat-composer" onSubmit={handleSubmitChat}>
          <label htmlFor="app-prompt">{draft ? 'Update this app' : 'Create an app'}</label>
        <textarea
          id="app-prompt"
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            placeholder={draft ? 'Example: make the panel smaller and add a copy button.' : 'Example: summarize this page and highlight action items.'}
            rows={4}
        />
          <div className="disclosure">{disclosureText}</div>
        <button type="submit" className="primary-button" disabled={!canSend}>
            {saveState === 'saving' ? <Loader2 size={17} className="spin" /> : <Send size={17} />}
            {saveState === 'saving' ? 'Generating' : draft ? 'Update app' : 'Generate app'}
        </button>
        </form>
      </section>

      {draft && (
        <section className="draft-panel">
          <div className="draft-heading">
            <div>
              <span className="eyebrow">Generated app plan</span>
              <h2>{draft.name}</h2>
            </div>
            <span className={draft.status === 'saved' ? 'status saved' : 'status'}>{draft.status === 'saved' ? 'Saved' : 'Draft'}</span>
          </div>
          <p className="summary">Latest request: {draft.prompt}</p>
          <ApprovalList draft={draft} />
          <div className="action-row">
            {(draft.status !== 'saved' || saveState === 'error') && (
              <button type="button" className="primary-button" onClick={handleSaveDraft} disabled={saveState === 'saving'}>
                {saveState === 'saving' ? <Loader2 size={17} className="spin" /> : <Save size={17} />}
                {saveState === 'saving' ? 'Saving app' : 'Save app'}
              </button>
            )}
            {savedAppId && (
              <button type="button" className="secondary-button" onClick={openSavedApp}>
                <ExternalLink size={16} />
                Open app
              </button>
            )}
            {savedAppId && typeof draft.target?.id === 'number' && (
              <button type="button" className="secondary-button" onClick={refreshTargetPage} disabled={applyState === 'applying'}>
                {applyState === 'applying' ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
                {applyState === 'applying' ? 'Refreshing' : 'Refresh page'}
              </button>
            )}
            <button type="button" className="secondary-button" onClick={openDashboard}>
              <ExternalLink size={16} />
              Dashboard
            </button>
          </div>
          {saveState === 'saved' && <p className={draft.persistence?.mode === 'local' ? 'warning' : 'success'}>{saveNotice || 'Saved.'}</p>}
          {applyState === 'applied' && <p className="success">Page refreshed. The on-page Airglow panel should appear after the page loads.</p>}
          {applyState === 'error' && <p className="error">{applyError || 'Could not refresh the target page.'}</p>}
          {saveState === 'error' && <p className="error">{saveError || 'Could not save this app draft.'}</p>}
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
