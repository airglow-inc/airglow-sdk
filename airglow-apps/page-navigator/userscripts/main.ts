declare const airglow: any;
import { createChatWindow, type ChatMessage } from '../../shared/widgets/chat-window';
import iconSvg from '../../shared/logo/icon.svg';
import { marked } from 'marked';
import { applyHighlights, clearHighlights } from './highlight';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const POS_KEY = `page-navigator-pos:${location.hostname}`;
const NAME_KEY = `page-navigator-site-name:${location.hostname}`;
const DOMAINS_KEY = 'page_navigator_domains';
const PILL_ID = 'airglow-page-navigator-pill';

async function isDomainAllowed(): Promise<boolean> {
  const raw = await airglow.storage.get(DOMAINS_KEY);
  let domains: string[] = [];
  if (Array.isArray(raw)) domains = raw;
  else if (typeof raw === 'string') { try { const p = JSON.parse(raw); if (Array.isArray(p)) domains = p; } catch {} }
  if (!domains.length) return false;
  const host = location.hostname.replace(/^www\./, '');
  return domains.some(d => host === d || host.endsWith('.' + d));
}

// ── Site name via Haiku ──

let _siteName: string | null = null;
let _sitePromise: Promise<string> | null = null;

async function getSiteName(): Promise<string> {
  if (_siteName) return _siteName;
  if (_sitePromise) return _sitePromise;

  _sitePromise = (async () => {
    const cacheInput = `${location.hostname}|${document.title}`;
    try {
      const cached = await airglow.storage.get(NAME_KEY);
      if (cached && typeof cached === 'object' && cached.input === cacheInput) {
        _siteName = cached.name;
        return cached.name as string;
      }
    } catch {}

    const apiKey = await airglow.storage.get('ANTHROPIC_API_KEY');
    if (!apiKey) return location.hostname;

    try {
      const res = await airglow.fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 30,
          messages: [{ role: 'user', content: `What website/web app is this? Output ONLY the website name (1-3 words, no quotes). I want the name of the website itself, NOT the name of any content on the page.\n\nExamples:\n- github.com, title "steipete/birdclaw" -> GitHub\n- docs.google.com, title "Budget 2025" -> Google Docs\n- mail.google.com, title "Inbox (3)" -> Gmail\n- console.cloud.google.com, title "VM instances" -> Google Cloud Console\n\nDomain: ${location.hostname}\nTitle: ${document.title}` }],
        }),
      });
      const data = await res.json();
      const name = data.content?.[0]?.text?.trim() || location.hostname;
      _siteName = name;
      airglow.storage.set(NAME_KEY, { input: cacheInput, name }).catch(() => {});
      return name;
    } catch {
      return location.hostname;
    }
  })();

  return _sitePromise;
}

interface ApiMessage {
  role: 'user' | 'assistant';
  content: any;
}

type ActionKind = 'click' | 'type' | 'select' | 'check' | 'press';

interface InstructionStep {
  action: ActionKind;
  target: string;
  value?: string;
}

interface Instruction {
  title: string;
  steps: InstructionStep[];
  shortcut?: string;
  note?: string;
}

const systemPrompt = `You help users figure out how to do things on the website they're looking at. Each user message includes a screenshot of the current page state.

WHEN GIVING NAVIGATION INSTRUCTIONS — call the show_instruction tool. Never describe steps in prose if you can express them as a structured instruction.

WHEN ANSWERING CONCEPTUAL QUESTIONS or when you cannot determine exact UI steps — respond in plain markdown (no tool).

Rules for show_instruction:
- "target" must be the literal on-screen label of the UI element, no verbs, no extra words ("Settings (gear icon)", NOT "the settings gear in the top right").
- For action=type: put the field label in "target" and the value the user should type in "value".
- For action=select: put the dropdown label in "target" and the option to pick in "value".
- For action=press: put the keyboard combo in "target" (e.g. "⌘+K"). Use ⌘ on Mac, Ctrl elsewhere.
- "shortcut" is an OPTIONAL whole-sequence keyboard alternative (different from per-step press actions).
- "note" is OPTIONAL — one short caveat only if genuinely useful. Skip otherwise.
- Order steps from start to finish. Include every submenu level.

Current page:
- URL: ${location.href}
- Title: ${document.title}
- Domain: ${location.hostname}`;

const SHOW_INSTRUCTION_TOOL = {
  name: 'show_instruction',
  description: 'Render a structured step-by-step instruction for performing an action on the current page.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' as const, description: 'Short summary of what the steps achieve' },
      steps: {
        type: 'array' as const,
        description: 'Ordered list of UI actions to perform',
        items: {
          type: 'object' as const,
          properties: {
            action: { type: 'string' as const, enum: ['click', 'type', 'select', 'check', 'press'], description: 'What the user does' },
            target: { type: 'string' as const, description: 'On-screen label of the UI element, or keyboard combo for press actions' },
            value: { type: 'string' as const, description: 'For type/select: the text to enter or the option to choose' },
          },
          required: ['action', 'target'],
        },
      },
      shortcut: { type: 'string' as const, description: 'Optional whole-sequence keyboard shortcut alternative (e.g. "⌘+K")' },
      note: { type: 'string' as const, description: 'Optional one-line caveat or tip' },
    },
    required: ['title', 'steps'],
  },
};

// ── Rendering ──

const ACTION_STYLE: Record<ActionKind, { bg: string; fg: string }> = {
  click:  { bg: 'color-mix(in srgb, #6d9ecf 18%, transparent)', fg: '#2a567f' },
  type:   { bg: 'color-mix(in srgb, #6cab7a 18%, transparent)', fg: '#2f6b3f' },
  select: { bg: 'color-mix(in srgb, #e8a050 18%, transparent)', fg: '#a05f1c' },
  check:  { bg: 'color-mix(in srgb, #7cb8b0 22%, transparent)', fg: '#2d6a64' },
  press:  { bg: 'color-mix(in srgb, #9b7ed0 18%, transparent)', fg: '#5a3f95' },
};

function el(tag: string, css: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderInstructionCard(ins: Instruction): HTMLElement {
  const card = el('div', `
    background: #fff;
    border: 1.5px solid #e5e3d9;
    border-radius: 12px;
    padding: 12px 14px;
    max-width: 95%;
    font-size: 15px;
    line-height: 1.5;
    box-shadow: 0 1px 4px rgba(0,0,0,0.05);
  `);

  // Title row (with optional shortcut chip on the right)
  const titleRow = el('div', 'display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;');
  const title = el('div', 'font-weight:600;font-size:16px;color:#1a1a1a;flex:1;', ins.title);
  titleRow.appendChild(title);
  if (ins.shortcut) {
    const sc = el('span', `
      flex-shrink:0;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 12px; font-weight: 600;
      padding: 3px 8px; border-radius: 6px;
      background: #f4f1e8; color: #6b4ea0;
      border: 1px solid #e5e0d2;
    `, ins.shortcut);
    titleRow.appendChild(sc);
  }
  card.appendChild(titleRow);

  // Steps
  const stepsWrap = el('div', 'display:flex;flex-direction:column;gap:6px;');
  ins.steps.forEach((s, i) => {
    const row = el('div', 'display:flex;align-items:center;gap:8px;');

    const num = el('span', `
      flex-shrink:0; width:22px; height:22px; border-radius:50%;
      background:#e8a050; color:#fff;
      font-size:12px; font-weight:700;
      display:flex; align-items:center; justify-content:center;
    `, String(i + 1));

    const action = ACTION_STYLE[s.action] || ACTION_STYLE.click;
    const actionPill = el('span', `
      flex-shrink:0; padding:2px 8px; border-radius:6px;
      font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
      background:${action.bg}; color:${action.fg};
    `, s.action);

    const target = el('span', 'color:#1a1a1a; font-weight:500;');
    if (s.action === 'press') {
      target.style.fontFamily = 'ui-monospace, "SF Mono", Menlo, monospace';
      target.style.fontSize = '13px';
      target.style.background = '#f4f1e8';
      target.style.padding = '2px 6px';
      target.style.borderRadius = '4px';
      target.style.border = '1px solid #e5e0d2';
    }
    target.textContent = s.target;

    row.appendChild(num);
    row.appendChild(actionPill);
    row.appendChild(target);

    if (s.value) {
      const arrow = el('span', 'color:#9a958e; font-size:13px;', '→');
      const value = el('span', `
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 13px; color:#2f6b3f;
        background: color-mix(in srgb, #6cab7a 10%, transparent);
        padding: 2px 8px; border-radius: 4px;
        border: 1px solid color-mix(in srgb, #6cab7a 28%, transparent);
      `, s.value);
      row.appendChild(arrow);
      row.appendChild(value);
    }

    stepsWrap.appendChild(row);
  });
  card.appendChild(stepsWrap);

  if (ins.note) {
    const note = el('div', `
      margin-top: 10px; padding-top: 8px;
      border-top: 1px dashed #e5e3d9;
      color: #6b6862; font-size: 13px; font-style: italic;
    `, ins.note);
    card.appendChild(note);
  }

  return card;
}

function renderMarkdownBubble(text: string): HTMLElement {
  const bubble = el('div', 'background:#f9f8f3;color:#3a3a37;padding:8px 12px;border-radius:10px 10px 10px 2px;max-width:90%;font-size:15px;line-height:1.55;word-break:break-word;');
  bubble.innerHTML = marked.parse(text, { async: false }) as string;
  bubble.querySelectorAll('p, ul, ol, pre').forEach(e => { (e as HTMLElement).style.margin = '4px 0'; });
  bubble.querySelectorAll('ul, ol').forEach(e => { (e as HTMLElement).style.paddingLeft = '20px'; });
  bubble.querySelectorAll('code').forEach(e => {
    const x = e as HTMLElement;
    if (x.parentElement?.tagName !== 'PRE') x.style.cssText = 'background:#efece4;padding:1px 5px;border-radius:3px;font-size:13px;';
  });
  bubble.querySelectorAll('pre').forEach(e => {
    (e as HTMLElement).style.cssText = 'background:#efece4;padding:8px 10px;border-radius:6px;font-size:13px;overflow-x:auto;margin:4px 0;';
  });
  return bubble;
}

// ── Backend ──

function stripPriorImages(messages: ApiMessage[]) {
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const kept = m.content.filter((b: any) => b.type !== 'image');
    if (kept.length === m.content.length) continue;
    m.content = kept.length === 1 && kept[0].type === 'text' ? kept[0].text : kept;
  }
}

function createBackend() {
  const apiMessages: ApiMessage[] = [];

  async function send(userQuestion: string): Promise<ChatMessage[]> {
    const apiKey = await airglow.storage.get('ANTHROPIC_API_KEY');
    if (!apiKey) return [{ role: 'assistant', element: renderMarkdownBubble('**ANTHROPIC_API_KEY** is not configured. Set it in Airglow settings.') }];

    let screenshot: { base64: string; mediaType: string } | null = null;
    try {
      screenshot = await airglow.captureTab();
    } catch (e: any) {
      console.warn('[page-navigator] screenshot failed:', e?.message);
    }

    stripPriorImages(apiMessages);

    const content: any[] = [];
    if (screenshot) {
      content.push({ type: 'image', source: { type: 'base64', media_type: screenshot.mediaType, data: screenshot.base64 } });
    }
    content.push({ type: 'text', text: userQuestion });
    apiMessages.push({ role: 'user', content });

    const out: ChatMessage[] = [];
    const collectedSteps: InstructionStep[] = [];

    try {
      let keepGoing = true;
      while (keepGoing) {
        const res = await airglow.fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2048,
            system: systemPrompt,
            tools: [SHOW_INSTRUCTION_TOOL],
            messages: apiMessages,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || 'Claude API error');

        const blocks = data.content || [];
        apiMessages.push({ role: 'assistant', content: blocks });

        const toolResults: any[] = [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text.trim()) {
            out.push({ role: 'assistant', element: renderMarkdownBubble(b.text.trim()) });
          } else if (b.type === 'tool_use' && b.name === 'show_instruction') {
            const ins = b.input as Instruction;
            out.push({ role: 'assistant', element: renderInstructionCard(ins) });
            collectedSteps.push(...ins.steps);
            toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: 'Instruction rendered to user.' });
          }
        }

        if (data.stop_reason === 'tool_use' && toolResults.length > 0) {
          apiMessages.push({ role: 'user', content: toolResults });
        } else {
          keepGoing = false;
        }
      }
      if (collectedSteps.length > 0) applyHighlights(collectedSteps);
      return out;
    } catch (e: any) {
      apiMessages.pop();
      return [{ role: 'assistant', element: renderMarkdownBubble(`Error: ${e?.message || 'unknown'}`) }];
    }
  }

  function clear() {
    apiMessages.length = 0;
    clearHighlights();
  }

  return { send, clear };
}

// ── Mount ──

function mount() {
  if (document.getElementById(PILL_ID)) return;

  const backend = createBackend();
  const prefix = 'page-navigator';

  // ── Pill ──
  const pill = document.createElement('div');
  pill.id = PILL_ID;
  pill.setAttribute('data-testid', `${prefix}-pill`);
  pill.innerHTML = `
    <div style="flex-shrink:0;width:18px;height:18px;display:flex;align-items:center;justify-content:center;">${
      iconSvg.replace(/<svg /, '<svg width="18" height="18" style="border-radius:3px;" ')
    }</div>
    <span style="font-size:15px;color:#5b5a56;font-weight:500;white-space:nowrap;">How to</span>`;
  Object.assign(pill.style, {
    position: 'fixed',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 14px 6px 10px',
    background: '#fff',
    border: '2px solid #e8a050',
    borderRadius: '20px',
    cursor: 'grab',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    zIndex: '999999',
    userSelect: 'none',
    touchAction: 'none',
    boxShadow: '0 2px 12px rgba(0,0,0,0.10)',
  });

  const defaultPos = { x: 16, y: window.innerHeight - 50 };
  pill.style.left = defaultPos.x + 'px';
  pill.style.top = defaultPos.y + 'px';
  airglow.storage.get(POS_KEY).then((pos: any) => {
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      setPillPos(pos.x, pos.y);
    }
  });

  // ── Chat window ──
  const chatWindow = createChatWindow({
    prefix,
    pillText: 'How to',
    panelTitle: 'Page Navigator',
    emptyText: 'Ask how to do anything on this page',
    inputPlaceholder: 'How do I…',
    onSend: (q) => backend.send(q),
    onClear: () => backend.clear(),
    panelAbove: true,
  });
  const built = chatWindow.build(document.body);
  built.pill.style.display = 'none';

  // Replace static panel title with the Haiku-inferred website name
  const titleEl = built.chatBox.querySelector('span') as HTMLSpanElement | null;
  if (titleEl) {
    getSiteName().then(name => { titleEl.textContent = name; }).catch(() => {});
  }

  function positionPanel() {
    const rect = pill.getBoundingClientRect();
    const panelW = 460;
    built.chatBox.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    built.chatBox.style.left = Math.min(window.innerWidth - panelW - 8, rect.left) + 'px';
    built.chatBox.style.top = 'auto';
    built.chatBox.style.right = 'auto';
  }

  function setPillPos(x: number, y: number) {
    const cx = Math.max(0, Math.min(window.innerWidth - pill.offsetWidth, x));
    const cy = Math.max(0, Math.min(window.innerHeight - pill.offsetHeight, y));
    pill.style.left = cx + 'px';
    pill.style.top = cy + 'px';
    if (isOpen) positionPanel();
  }

  function savePos() {
    airglow.storage.set(POS_KEY, {
      x: parseInt(pill.style.left) || defaultPos.x,
      y: parseInt(pill.style.top) || defaultPos.y,
    }).catch(() => {});
  }

  // ── Drag ──
  let dragging = false;
  let dragMoved = false;
  let dragStartX = 0, dragStartY = 0, btnStartX = 0, btnStartY = 0;
  let pillW = 0, pillH = 0;

  pill.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    dragging = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    btnStartX = parseInt(pill.style.left) || 0;
    btnStartY = parseInt(pill.style.top) || 0;
    pillW = pill.offsetWidth;
    pillH = pill.offsetHeight;
    pill.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
    const cx = Math.max(0, Math.min(window.innerWidth - pillW, btnStartX + dx));
    const cy = Math.max(0, Math.min(window.innerHeight - pillH, btnStartY + dy));
    pill.style.left = cx + 'px';
    pill.style.top = cy + 'px';
    if (isOpen) positionPanel();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    pill.style.cursor = 'grab';
    if (dragMoved) savePos();
  });

  // ── Toggle ──
  let isOpen = false;

  pill.addEventListener('mouseenter', () => {
    if (dragging) return;
    pill.style.borderColor = '#d08030';
    pill.style.boxShadow = '0 2px 16px rgba(232,160,80,0.25)';
  });
  pill.addEventListener('mouseleave', () => {
    pill.style.borderColor = '#e8a050';
    pill.style.boxShadow = '0 2px 12px rgba(0,0,0,0.10)';
  });

  pill.addEventListener('click', () => {
    if (dragMoved) { dragMoved = false; return; }
    isOpen = !isOpen;
    built.chatBox.style.display = isOpen ? 'flex' : 'none';
    if (isOpen) positionPanel();
  });

  document.body.appendChild(pill);

  window.addEventListener('scroll', () => { if (isOpen) positionPanel(); }, { passive: true });
  window.addEventListener('resize', () => {
    setPillPos(parseInt(pill.style.left) || 0, parseInt(pill.style.top) || 0);
    if (isOpen) positionPanel();
  });
}

async function init() {
  if (!(await isDomainAllowed())) return;
  mount();
  new MutationObserver(() => {
    if (!document.getElementById(PILL_ID)) mount();
  }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
