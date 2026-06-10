import { Fragment, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
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

type GenerationPhase = 'idle' | 'reading_context' | 'generating' | 'ready' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'local' | 'error';
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
        <Popover.Content
          className="help-popover"
          side="top"
          align="start"
          sideOffset={10}
          aria-label="Context and permissions"
        >
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
        <span>Page context</span>
        <IconTooltip label="Refresh page context">
          <button type="button" className="inline-icon-button" onClick={onRefresh} disabled={loadingTarget} aria-label="Refresh page context">
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

function saveStateTitle(draft: AirglowAppDraft, saveState: SaveState): string {
  if (saveState === 'local' || draft.persistence?.mode === 'local') return 'Draft saved locally';
  if (saveState === 'saved' && draft.persistence?.mode === 'cloud') return 'App saved';
  return 'Draft ready';
}

function App() {
  const [target, setTarget] = useState<SidePanelTargetTab | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [draft, setDraft] = useState<AirglowAppDraft | null>(null);
  const [generationPhase, setGenerationPhase] = useState<GenerationPhase>('idle');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAppId, setSavedAppId] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);
  const [generationStepIndex, setGenerationStepIndex] = useState<number | null>(null);
  const chatLogRef = useRef<HTMLDivElement | null>(null);

  async function readTargetContext(): Promise<SidePanelTargetTab | null> {
    setLoadingTarget(true);
    setTargetError(null);
    try {
      const response = await sendRuntimeMessage<TargetResponse>({ type: 'airglow:sidepanel:get-target' });
      const nextTarget = response.target ?? null;
      setTarget(nextTarget);
      return nextTarget;
    } catch (error) {
      setTarget(null);
      setTargetError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setLoadingTarget(false);
    }
  }

  async function refreshTarget() {
    const nextTarget = await readTargetContext();
    setDraft((current) => current ? { ...current, target: nextTarget, updatedAt: new Date().toISOString() } : current);
  }

  useEffect(() => {
    if (saveState !== 'saving') {
      setGenerationStepIndex(null);
      return;
    }
    setGenerationStepIndex(1);
    const intervalId = window.setInterval(() => {
      setGenerationStepIndex((current) => Math.min((current ?? 0) + 1, GENERATION_STEPS.length - 1));
    }, 2200);
    return () => window.clearInterval(intervalId);
  }, [saveState]);

  useEffect(() => {
    const log = chatLogRef.current;
    if (!log) return;
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  }, [draft?.messages.length, draft?.target?.id, generationPhase, saveState, generationStepIndex, applyState, saveError, applyError]);

  const generationBusy = generationPhase === 'reading_context' || generationPhase === 'generating';
  const canSend = chatInput.trim().length > 0 && !generationBusy;

  const disclosureText = useMemo(() => {
    if (loadingTarget) return 'Reading selected page context for this app request.';
    if (!target) {
      if (targetError) return `Page context is unavailable: ${targetError}`;
      return 'Airglow reads selected page context after you send an app request. Read-only context does not need approval.';
    }
    return `Using the selected tab title, URL, and visible text for generation. The saved app can refresh read-only page text on ${targetOrigin(target)} after it is installed.`;
  }, [loadingTarget, target, targetError]);

  async function saveDraftToCloud(draftToSave: AirglowAppDraft) {
    setGenerationPhase('generating');
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
        setSaveState('saved');
        setGenerationPhase('ready');
      } else {
        setSavedAppId(null);
        setSaveState('local');
        setGenerationPhase('error');
        setSaveError(response.cloudError.message || 'Cloud save failed.');
      }
      setApplyState('idle');
      setApplyError(null);
    } catch (error) {
      setSaveState('error');
      setGenerationPhase('error');
      setSaveError(error instanceof Error ? error.message : String(error));
      setSavedAppId(null);
    }
  }

  async function handleSubmitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) return;
    const content = chatInput.trim();
    const nonce = crypto.randomUUID();
    const draftForChat = draft
      ? appendDraftUserMessage(draft, { content, nonce })
      : createAppDraft({
          prompt: content,
          target: null,
          nonce,
        });
    setDraft(draftForChat);
    setChatInput('');
    setSaveState('idle');
    setSaveError(null);
    setApplyState('idle');
    setApplyError(null);
    const needsTargetContext = !draftForChat.target;
    let draftToSave = draftForChat;
    if (needsTargetContext) {
      setGenerationPhase('reading_context');
      const nextTarget = await readTargetContext();
      draftToSave = { ...draftForChat, target: nextTarget, updatedAt: new Date().toISOString() };
      setDraft(draftToSave);
    }
    await saveDraftToCloud(draftToSave);
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

  const shouldShowTargetContext = Boolean(draft && (loadingTarget || target || targetError));
  const firstAssistantMessageIndex = draft?.messages.findIndex((message) => message.role === 'assistant') ?? -1;
  const targetContextMessage = shouldShowTargetContext ? (
    <TargetContextMessage
      target={target}
      targetError={targetError}
      loadingTarget={loadingTarget}
      onRefresh={refreshTarget}
    />
  ) : null;

  return (
    <Tooltip.Provider delayDuration={160} skipDelayDuration={100}>
      <main className="sidepanel">
        <section className="chat-panel">
          <div className="chat-log" ref={chatLogRef} aria-live="polite">
            {draft?.messages.length ? draft.messages.map((message) => (
              <Fragment key={message.id}>
                {firstAssistantMessageIndex !== -1 && draft.messages[firstAssistantMessageIndex]?.id === message.id && targetContextMessage}
                <div className={`chat-message ${message.role}`}>
                  <span>{message.role === 'user' ? 'You' : 'Airglow'}</span>
                  <p>{message.content}</p>
                </div>
              </Fragment>
            )) : (
              <>
                <WelcomeMessage />
                <QuickPromptChips onPick={setChatInput} />
              </>
            )}
            {draft?.messages.length && firstAssistantMessageIndex === -1 ? targetContextMessage : null}
            {(generationPhase === 'reading_context' || saveState === 'saving') && (
              <GenerationProgress stepIndex={generationPhase === 'reading_context' ? 0 : generationStepIndex ?? 1} />
            )}
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
                <p><strong>{saveStateTitle(draft, saveState)}</strong></p>
                <div className="message-actions">
                  {(saveState === 'error' || saveState === 'local') && (
                    <IconTooltip label="Save again">
                      <button type="button" className="secondary-button" onClick={handleSaveDraft}>
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
                  {savedAppId && (
                    <IconTooltip label="Open dashboard">
                      <button type="button" className="secondary-button" onClick={openDashboard}>
                        <ExternalLink size={16} />
                        Dashboard
                      </button>
                    </IconTooltip>
                  )}
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
