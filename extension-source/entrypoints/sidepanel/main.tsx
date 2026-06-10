import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Popover from '@radix-ui/react-popover';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Check, CircleHelp, ExternalLink, Loader2, RefreshCw, Send, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import './style.css';
import {
  type AirglowAppDraft,
  type SidePanelTargetTab,
  appendDraftUserMessage,
  createAppDraft,
} from '../../lib/sidepanel-model';

type TargetResponse = {
  target?: SidePanelTargetTab | null;
  error?: string;
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type ApplyState = 'idle' | 'applying' | 'applied' | 'error';

const GENERATION_STEPS = [
  'Reading page context...',
  'Generating UI...',
  'Generating logic...',
  'Packaging app...',
  'Saving private app...',
];

const QUICK_PROMPTS = [
  'Summarize this page and highlight action items.',
  'Create a compact research helper for this page.',
  'Extract key data into a small floating app.',
];

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

function IconTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={7}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function ContextPopover({
  draft,
  disclosureText,
}: {
  draft: AirglowAppDraft | null;
  disclosureText: string;
}) {
  return (
    <Popover.Root>
      <IconTooltip label="Context and permissions">
        <Popover.Trigger asChild>
          <button type="button" className="help-button" aria-label="Show context and safety details">
            <CircleHelp size={16} />
          </button>
        </Popover.Trigger>
      </IconTooltip>
      <Popover.Portal>
        <Popover.Content className="help-popover" side="top" align="start" sideOffset={10}>
          <p>{disclosureText}</p>
          {draft ? (
            <ApprovalList draft={draft} />
          ) : (
            <p>Read-only page context can be used without approval. UX-changing browser actions require explicit approval before Airglow runs them.</p>
          )}
          <Popover.Arrow className="help-popover-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function QuickPromptChips({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="quick-prompts" aria-label="Prompt suggestions">
      {QUICK_PROMPTS.map((prompt) => (
        <button key={prompt} type="button" className="quick-prompt" onClick={() => onPick(prompt)}>
          {prompt}
        </button>
      ))}
    </div>
  );
}

function GenerationProgress({ stepIndex }: { stepIndex: number }) {
  return (
    <div className="chat-message assistant progress">
      <span>Airglow</span>
      <div className="progress-steps" aria-label="Generation progress">
        {GENERATION_STEPS.map((label, index) => (
          <div
            key={label}
            className={index < stepIndex ? 'progress-step done' : index === stepIndex ? 'progress-step active' : 'progress-step'}
          >
            {index < stepIndex ? <Check size={14} /> : index === stepIndex ? <Loader2 size={14} className="spin" /> : <span className="step-dot" />}
            <p>{label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function AssistantStatusMessage({
  tone,
  title,
  children,
}: {
  tone?: 'error' | 'success';
  title: string;
  children: string;
}) {
  return (
    <div className={tone ? `chat-message assistant ${tone}` : 'chat-message assistant'}>
      <span>Airglow</span>
      <p><strong>{title}</strong></p>
      <p>{children}</p>
    </div>
  );
}

function TargetContextMessage({
  target,
  targetError,
  loadingTarget,
  onRefresh,
}: {
  target: SidePanelTargetTab | null;
  targetError: string | null;
  loadingTarget: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="chat-message assistant target-message">
      <div className="target-message-heading">
        <span>Target tab</span>
        <IconTooltip label="Refresh target tab">
          <button type="button" className="inline-icon-button" onClick={onRefresh} disabled={loadingTarget} aria-label="Refresh target tab">
            {loadingTarget ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          </button>
        </IconTooltip>
      </div>
      <p><strong>{loadingTarget ? 'Reading selected tab...' : targetLabel(target)}</strong></p>
      <p className="target-meta">{targetError || targetOrigin(target)}</p>
    </div>
  );
}

function WelcomeMessage() {
  return (
    <div className="chat-message assistant welcome-message">
      <span>Airglow</span>
      <p>Describe the app you want to build for this page.</p>
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
  const [savedAppId, setSavedAppId] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);
  const [generationStepIndex, setGenerationStepIndex] = useState<number | null>(null);
  const chatLogRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (saveState !== 'saving') {
      setGenerationStepIndex(null);
      return;
    }
    setGenerationStepIndex(0);
    const intervalId = window.setInterval(() => {
      setGenerationStepIndex((current) => Math.min((current ?? 0) + 1, GENERATION_STEPS.length - 1));
    }, 2200);
    return () => window.clearInterval(intervalId);
  }, [saveState]);

  useEffect(() => {
    const log = chatLogRef.current;
    if (!log) return;
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  }, [draft?.messages.length, saveState, generationStepIndex, applyState, saveError, applyError]);

  const canSend = chatInput.trim().length > 0 && !loadingTarget && saveState !== 'saving';

  const disclosureText = useMemo(() => {
    if (!target) return 'Select a browser tab to give Airglow page context.';
    return `Using the selected tab title, URL, and visible text for generation. The saved app can refresh read-only page text on ${targetOrigin(target)} after it is installed.`;
  }, [target]);

  async function saveDraftToCloud(draftToSave: AirglowAppDraft) {
    setSaveState('saving');
    setSaveError(null);
    try {
      const response = await sendRuntimeMessage<SaveDraftResponse>({
        type: 'airglow:sidepanel:save-draft',
        requestId: crypto.randomUUID(),
        draft: draftToSave,
      });
      setDraft(response.draft);
      if (response.mode === 'cloud') {
        setSavedAppId(response.cloud.appId);
      } else {
        setSavedAppId(null);
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
    <Tooltip.Provider delayDuration={160} skipDelayDuration={100}>
      <main className="sidepanel">
        <section className="chat-panel">
          <div className="chat-log" ref={chatLogRef} aria-live="polite">
            <TargetContextMessage
              target={target}
              targetError={targetError}
              loadingTarget={loadingTarget}
              onRefresh={refreshTarget}
            />
            {draft?.messages.length ? draft.messages.map((message) => (
              <div key={message.id} className={`chat-message ${message.role}`}>
                <span>{message.role === 'user' ? 'You' : 'Airglow'}</span>
                <p>{message.content}</p>
              </div>
            )) : (
              <>
                <WelcomeMessage />
                <QuickPromptChips onPick={setChatInput} />
              </>
            )}
            {saveState === 'saving' && <GenerationProgress stepIndex={generationStepIndex ?? 0} />}
            {saveState === 'error' && (
              <AssistantStatusMessage
                tone="error"
                title="Generation failed"
              >
                {saveError || 'Could not save this app draft.'}
              </AssistantStatusMessage>
            )}
            {applyState === 'applying' && (
              <AssistantStatusMessage title="Refreshing page">
                Refreshing the target page so the generated app can inject.
              </AssistantStatusMessage>
            )}
            {applyState === 'applied' && (
              <AssistantStatusMessage tone="success" title="Page refreshed">
                The on-page Airglow panel should appear after the page loads.
              </AssistantStatusMessage>
            )}
            {applyState === 'error' && (
              <AssistantStatusMessage tone="error" title="Refresh failed">
                {applyError || 'Could not refresh the target page.'}
              </AssistantStatusMessage>
            )}
            {draft && saveState !== 'saving' && (
              <div className="chat-message assistant actions-message">
                <span>Airglow</span>
                <p><strong>{draft.status === 'saved' ? 'App saved' : 'Draft ready'}</strong></p>
                <div className="message-actions">
                  {saveState === 'error' && (
                    <IconTooltip label="Save again">
                      <button type="button" className="secondary-button" onClick={handleSaveDraft} disabled={saveState === 'saving'}>
                        <RefreshCw size={16} />
                        Try again
                      </button>
                    </IconTooltip>
                  )}
                  {savedAppId && (
                    <IconTooltip label="Open generated app">
                      <button type="button" className="secondary-button" onClick={openSavedApp}>
                        <ExternalLink size={16} />
                        Open app
                      </button>
                    </IconTooltip>
                  )}
                  {savedAppId && typeof draft.target?.id === 'number' && (
                    <IconTooltip label="Reload the target tab">
                      <button type="button" className="secondary-button" onClick={refreshTargetPage} disabled={applyState === 'applying'}>
                        {applyState === 'applying' ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
                        {applyState === 'applying' ? 'Refreshing' : 'Refresh page'}
                      </button>
                    </IconTooltip>
                  )}
                  <IconTooltip label="Open dashboard">
                    <button type="button" className="secondary-button" onClick={openDashboard}>
                      <ExternalLink size={16} />
                      Dashboard
                    </button>
                  </IconTooltip>
                </div>
              </div>
            )}
          </div>
          <form className="chat-composer" onSubmit={handleSubmitChat}>
            <div className="composer-row">
              <ContextPopover draft={draft} disclosureText={disclosureText} />
              <textarea
                id="app-prompt"
                aria-label={draft ? 'Update this app' : 'Create an app'}
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder={draft ? 'Update this app...' : 'Message Airglow...'}
                rows={1}
              />
              <IconTooltip label={draft ? 'Update app' : 'Generate app'}>
                <button type="submit" className="send-button" disabled={!canSend} aria-label={draft ? 'Update app' : 'Generate app'}>
                  {saveState === 'saving' ? <Loader2 size={17} className="spin" /> : <Send size={17} />}
                </button>
              </IconTooltip>
            </div>
          </form>
        </section>
      </main>
    </Tooltip.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
