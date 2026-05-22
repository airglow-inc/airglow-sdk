declare const airglow: any;
import iconSvg from '../../shared/logo/icon.svg';
import tokensCSS from '../../shared/theme/tokens-injectable';

// ── Types ──

interface ScrapedProfile {
  name: string;
  headline: string;
  location: string;
  about: string;
  experience: string[];
  education: string[];
  fullText: string;
  profileUrl: string;
}

interface EntryData {
  title: string;
  subtitle?: string;
  detail?: string;
}

interface UserGoal {
  iam: string;
  goal: string;
  notes: string;
}

interface ResearchResult {
  structured: Record<string, any> | null;
  text: string;
  suggestedQuestions?: string[];
}

// ── Schema ──

const REF_ITEM = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Fact label — under 6 words' },
    subtitle: { type: 'string', description: 'Brief context — under 8 words' },
  },
  required: ['title'],
};

const RESEARCH_SCHEMA: any = {
  type: 'object',
  properties: {
    person_summary: {
      type: 'object',
      properties: {
        current_role: { type: 'string', description: 'Current title and company, e.g. "GP @ SV Angel (seed-stage VC fund)"' },
        joined: { type: 'string', description: 'Year they started current role, e.g. "2019". Just the year number, nothing else.' },
        location: { type: 'string', description: 'Where they are based' },
        age_approx: { type: 'string', description: 'Approximate age or age range if findable, e.g. "~35" or "mid-30s". Empty string if unknown.' },
      },
      required: ['current_role', 'location'],
      description: 'Key facts about the person for the header. Include a short parenthetical describing what their company/org does.',
    },
    tldr: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '1-3 word label, e.g. "Background", "Relevance", "Notable"' },
          text: { type: 'string', description: 'One sentence expanding the label' },
        },
        required: ['label', 'text'],
      },
      description: '2-4 bullet points. Each has a short label + explanation. Who they are + why they matter TO THE USER. Not a bio — a relevance briefing. No filler.',
    },
    talking_points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'One-line conversation opener. Under 15 words. "Ask about X" or "Mention Y" format.' },
          detail: { type: 'string', description: '1-2 sentences of context: what is this thing, why it matters, what to know before bringing it up.' },
        },
        required: ['text', 'detail'],
      },
      description: '3-4 conversation openers tailored to the user\'s goal. Each has a short text + expandable detail with context.',
    },
    quick_reference: {
      type: 'array',
      items: REF_ITEM,
      description: 'Compact career facts: current role, past key roles, education. Max 4 entries. Title=fact, subtitle=what the org does or context. No paragraphs.',
    },
    recent_activity: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What happened — under 8 words' },
          subtitle: { type: 'string', description: 'Brief context' },
          date: { type: 'string', description: 'When — month+year or year, e.g. "Feb 2024" or "2025"' },
        },
        required: ['title', 'date'],
      },
      description: 'What they\'re doing NOW — recent news, posts, launches, investments, talks from the last 1-2 years. Max 3 entries. Each must have a date.',
    },
    suggested_questions: {
      type: 'array',
      items: { type: 'string' },
      description: '3 follow-up questions the user might ask about this person (max 50 chars each)',
    },
  },
  required: ['person_summary', 'tldr', 'talking_points', 'quick_reference', 'recent_activity', 'suggested_questions'],
};

// ── Markdown ──

function renderMarkdown(text: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = text.split('\n');
  const out: string[] = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const listMatch = line.match(/^[-*]\s+(.*)/);

    if (listMatch) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineMd(escape(listMatch[1]))}</li>`);
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      if (line.trim() === '') {
        out.push('');
      } else {
        out.push(`<p>${inlineMd(escape(line))}</p>`);
      }
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

function inlineMd(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// ── Constants ──

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const PANEL_WIDTH = 680;

const SECTION_META: Record<string, { color: string }> = {
  talking_points: { color: 'var(--clay)' },
  quick_reference: { color: 'var(--sky)' },
  recent_activity: { color: 'var(--olive)' },
};

// ── State ──

let isOpen = false;
let btnEl: HTMLElement | null = null;
let panelHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;

// ── Helpers ──

function cacheKey(url: string): string {
  const slug = url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '');
  return `linkedin_research_${slug}`;
}

function buildSystemPrompt(userGoal: UserGoal): string {
  const parts = [
    `You produce a compact research briefing about a person, personalized for the user's goals. This is a sidebar panel — space is limited. Every word must earn its place.`,
  ];
  if (userGoal.iam || userGoal.goal || userGoal.notes) {
    parts.push('', '## Who is reading this');
    if (userGoal.iam) parts.push(`I am: ${userGoal.iam}`);
    if (userGoal.goal) parts.push(`Looking for: ${userGoal.goal}`);
    if (userGoal.notes) parts.push(`Notes: ${userGoal.notes}`);
  }
  parts.push(
    '',
    '## Output rules',
    '- TLDR: 2-4 bullet points, each with a 1-3 word bold label and one sentence. Format: "Label: explanation". Not a bio — a relevance briefing. If not relevant, say so directly.',
    '- Talking points: 3-4 one-liners the user can actually say in conversation. Under 15 words each. "Ask about X" or "Mention Y" format.',
    '- Quick reference: max 4 entries. Current role, 1-2 past roles, education. Title under 6 words, subtitle must explain what the org does (e.g. "seed-stage VC fund" not just "Venture Capital"). NO detail paragraphs.',
    '- Recent activity: max 3 entries. News, investments, launches, talks from the last 1-2 years. If nothing recent found, return empty array.',
    '- Suggested questions: 3 follow-ups (max 50 chars each).',
    '- DO NOT pad sections. If there are only 2 relevant talking points, return 2. Empty sections are fine.',
    '- DO NOT write paragraphs or multi-sentence details. This is a quick-glance reference card.',
  );
  return parts.join('\n');
}

function buildUserMessage(profile: ScrapedProfile): string {
  return [
    `Research this person:`,
    ``,
    `Name: ${profile.name}`,
    `LinkedIn: ${profile.profileUrl}`,
    profile.headline ? `Headline: ${profile.headline}` : '',
    profile.location ? `Location: ${profile.location}` : '',
    profile.about ? `\nAbout:\n${profile.about}` : '',
    profile.experience.length ? `\nExperience:\n${profile.experience.map(e => `- ${e}`).join('\n')}` : '',
    profile.education.length ? `\nEducation:\n${profile.education.map(e => `- ${e}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

// ── API ──

async function loadUserGoal(): Promise<UserGoal> {
  const [iam, goal, notes] = await Promise.all([
    airglow.storage.get('linkedin_user_iam'),
    airglow.storage.get('linkedin_user_goal'),
    airglow.storage.get('linkedin_user_notes'),
  ]);
  return { iam: iam || '', goal: goal || '', notes: notes || '' };
}

async function callClaude(body: Record<string, any>): Promise<any> {
  const apiKey = await airglow.storage.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Missing API key — set ANTHROPIC_API_KEY in app settings');

  const res = await airglow.fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  return data;
}

async function runResearch(profile: ScrapedProfile): Promise<ResearchResult> {
  const userGoal = await loadUserGoal();
  const userMessage = buildUserMessage(profile);

  airglow.log.info('linkedin', `calling Claude API — message length: ${userMessage.length}`);

  const data = await callClaude({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    system: buildSystemPrompt(userGoal),
    tools: [
      { type: 'web_search_20250305' as any, name: 'web_search', max_uses: 5 },
      { name: 'research_output', description: 'Output structured research results', input_schema: RESEARCH_SCHEMA },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  airglow.log.info('linkedin', `API response — ${data.content?.length} blocks, stop: ${data.stop_reason}`);

  let structured: Record<string, any> | null = null;
  let text = '';
  let suggestedQuestions: string[] | undefined;
  for (const block of data.content || []) {
    if (block.type === 'tool_use' && block.name === 'research_output') {
      structured = block.input as Record<string, any>;
      if (Array.isArray(structured?.suggested_questions)) {
        suggestedQuestions = structured.suggested_questions;
      }
    } else if (block.type === 'text') {
      text += block.text;
    }
  }

  return { structured, text, suggestedQuestions };
}

// ── Scraping ──

function findNameSection(): { section: HTMLElement; nameH2: HTMLElement } | null {
  const titleName = document.title.replace(/\s*\|.*$/, '').trim();
  for (const h2 of document.querySelectorAll('section h2')) {
    const text = h2.textContent?.trim();
    if (text && titleName && text === titleName) {
      const section = h2.closest('section');
      if (section) return { section: section as HTMLElement, nameH2: h2 as HTMLElement };
    }
  }
  const h2s = document.querySelectorAll('section h2');
  if (h2s.length >= 2) {
    const h2 = h2s[1] as HTMLElement;
    const section = h2.closest('section');
    if (section) return { section: section as HTMLElement, nameH2: h2 };
  }
  return null;
}

function scrapeProfile(): ScrapedProfile {
  const ns = findNameSection();
  const name = ns?.nameH2.textContent?.trim() || document.title.replace(/\s*\|.*$/, '').trim() || 'Unknown';
  const sectionText = ns?.section.innerText || '';
  const lines = sectionText.split('\n').map(l => l.trim()).filter(Boolean);

  let headline = '';
  let location = '';
  const degreeIdx = lines.findIndex(l => /^·\s*\d+(st|nd|rd|th)$/.test(l));
  if (degreeIdx >= 0 && degreeIdx + 1 < lines.length) {
    headline = lines[degreeIdx + 1];
    if (degreeIdx + 2 < lines.length) {
      const candidate = lines[degreeIdx + 2];
      if (candidate.includes(',') || /\b(States|Kingdom|Canada|India|Germany|France|Israel|Australia)\b/.test(candidate)) {
        location = candidate;
      }
    }
  }

  const experience = scrapeListSection('Experience');
  const education = scrapeListSection('Education');

  if (experience.length === 0) {
    const skipWords = ['Message', 'Connect', 'Follow', 'More', 'Save in Sales Navigator', 'Pending'];
    const pronounPattern = /^(She|He|They|Ze)\//i;
    const companyLine = lines.find(l =>
      !l.startsWith('·') && l !== name && l !== headline && l !== location &&
      !l.includes('connections') && !l.includes('followers') && !l.includes('Contact info') &&
      !l.includes('mutual') && !pronounPattern.test(l) &&
      !skipWords.includes(l) && l.length > 2
    );
    if (companyLine) experience.push(companyLine);
  }
  if (education.length === 0) {
    const schoolKeywords = ['University', 'Institute', 'College', 'School', 'MIT', 'Stanford', 'Harvard', 'Berkeley', 'Caltech', 'Carnegie'];
    const schoolLine = lines.find(l => schoolKeywords.some(k => l.includes(k)));
    if (schoolLine) education.push(schoolLine);
  }

  let about = '';
  const aboutSection = findSectionByHeading('About');
  if (aboutSection) {
    about = aboutSection.innerText.replace(/^About\s*/i, '').trim().substring(0, 500);
  }

  const fullText = (document.querySelector('main') as HTMLElement)?.innerText || '';
  const profileUrl = window.location.href;
  return { name, headline, location, about, experience, education, fullText, profileUrl };
}

function findSectionByHeading(heading: string): HTMLElement | null {
  for (const el of document.querySelectorAll('section')) {
    const h2 = el.querySelector('h2');
    if (h2 && h2.textContent?.trim().toLowerCase() === heading.toLowerCase()) return el as HTMLElement;
  }
  return null;
}

function scrapeListSection(heading: string): string[] {
  const section = findSectionByHeading(heading);
  if (!section) return [];
  const text = section.innerText;
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && l !== heading);
  const items: string[] = [];
  for (const line of lines) {
    if (items.length >= 3) break;
    if (line === 'Show all' || line.startsWith('Show ') || line.length < 3) continue;
    if (/^\d+ (yr|mo|year|month)/.test(line)) continue;
    items.push(line);
  }
  return [...new Set(items)].slice(0, 3);
}

// ── Panel CSS ──

const PANEL_CSS = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483645;
  top: 0; right: 0; bottom: 0;
  width: ${PANEL_WIDTH}px;
  display: none;
  font-family: var(--font-sans);
  color: var(--fg-primary);

  /* Override rem-based tokens with px — shadow DOM rem resolves against host page */
  --text-body-3: 16px;
  --text-small: 14px;
  --text-caption: 13px;
  --text-micro: 11px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --radius-xs: 4px;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-full: 9999px;
}
:host(.ali-open) { display: flex; flex-direction: column; }

.panel-bg {
  display: flex; flex-direction: column;
  width: 100%; height: 100%;
  background: var(--bg-secondary);
  border-left: 3px solid var(--clay);
  box-shadow: -4px 0 20px rgba(0,0,0,0.08);
}

/* Header */
.header {
  position: sticky; top: 0; z-index: 10;
  background: var(--bg-white);
  border-bottom: 2px solid var(--border-primary);
  padding: 14px 20px;
  display: flex; align-items: center; justify-content: space-between;
}
.header-title {
  font-size: 20px; font-weight: 700;
  color: var(--fg-primary);
  display: flex; align-items: center; gap: 8px;
}
.header-actions { display: flex; gap: 8px; }

/* Buttons */
.btn-pill {
  font-size: var(--text-small); font-weight: 500;
  font-family: var(--font-sans);
  padding: 5px 16px; border-radius: var(--radius-full);
  cursor: pointer; border: 1px solid var(--border-secondary);
  background: var(--bg-white); color: var(--fg-secondary);
  transition: background var(--duration-fast);
}
.btn-pill:hover { background: var(--bg-tertiary); }

/* Content — always-visible scrollbar */
.content {
  flex: 1; overflow-y: auto; padding: 20px;
}
.content::-webkit-scrollbar { width: 4px; }
.content::-webkit-scrollbar-track { background: transparent; }
.content::-webkit-scrollbar-thumb {
  background: var(--gray-300); border-radius: 2px;
}
.content::-webkit-scrollbar-thumb:hover { background: var(--gray-400); }

/* Loading */
.loading {
  display: flex; align-items: center; gap: 12px;
  padding: 32px 0; justify-content: center;
}
.loading-text { font-size: var(--text-small); color: var(--fg-tertiary); }

.spinner {
  width: 16px; height: 16px;
  border: 2px solid var(--border-tertiary);
  border-top-color: var(--clay);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Error */
.error-text { font-size: var(--text-small); color: var(--error); padding: 16px 0; }

/* Cards */
.card {
  background: var(--bg-white);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

/* Hero */
.hero { padding: 20px; }
.hero-name { font-size: 20px; font-weight: 700; color: var(--fg-primary); margin: 0; display: flex; align-items: center; gap: 8px; }
.hero-name svg { opacity: 0.7; flex-shrink: 0; }
.hero-summary {
  font-size: var(--text-small); color: var(--fg-secondary); margin-top: 4px; line-height: 1.4;
}
.hero-summary span { color: var(--fg-tertiary); }
.hero-tldr {
  font-size: var(--text-small); color: var(--fg-secondary);
  margin: 12px 0 0 0; padding-left: 20px; line-height: 1.6;
  list-style: disc;
}
.hero-tldr li { margin-bottom: 2px; }

/* Sections layout */
.sections { display: flex; flex-direction: column; gap: 12px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

/* Section card */
.section-header {
  padding: 12px 16px 4px;
  display: flex; align-items: center; justify-content: space-between;
}
.section-header.clickable { cursor: pointer; }
.section-label {
  display: flex; align-items: center; gap: 8px;
}
.section-label svg { opacity: 0.7; }
.section-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.section-title {
  font-size: var(--text-caption); font-weight: 600;
  color: var(--fg-tertiary); text-transform: uppercase;
  letter-spacing: 0.05em;
}
.section-count { font-size: var(--text-caption); color: var(--fg-tertiary); }
.section-chevron {
  font-size: var(--text-small); color: var(--fg-secondary);
  transition: transform var(--duration-fast);
}
.section-chevron.collapsed { transform: rotate(-90deg); }
.section-body { padding: 0 16px 12px; }
.section-body.collapsed { display: none; }

/* Entry row */
.entry { padding: 8px 0; border-bottom: 1px solid var(--bg-secondary); }
.entry:last-child { border-bottom: none; }
.entry-row { display: flex; align-items: flex-start; gap: 8px; }
.entry-dot {
  width: 6px; height: 6px; border-radius: 50%;
  margin-top: 7px; flex-shrink: 0;
}
.entry-content { min-width: 0; flex: 1; }
.entry-title { font-size: var(--text-small); font-weight: 600; color: var(--fg-primary); line-height: 1.4; }
.entry-subtitle { font-size: var(--text-caption); color: var(--fg-tertiary); margin-top: 2px; }
.entry-date {
  font-size: var(--text-micro); color: var(--fg-tertiary);
  white-space: nowrap; margin-top: 7px; flex-shrink: 0;
}

/* Expandable talking point */
.tp-item { padding: 8px 0; border-bottom: 1px solid var(--bg-secondary); cursor: pointer; }
.tp-item:last-child { border-bottom: none; }
.tp-row { display: flex; align-items: flex-start; gap: 8px; }
.tp-text { font-size: var(--text-small); font-weight: 500; color: var(--fg-primary); line-height: 1.4; flex: 1; }
.tp-arrow { font-size: var(--text-small); color: var(--fg-secondary); margin-top: 4px; transition: transform var(--duration-fast); flex-shrink: 0; }
.tp-arrow.open { transform: rotate(90deg); }
.tp-detail {
  display: none; font-size: var(--text-caption); color: var(--fg-secondary);
  line-height: 1.5; margin-top: 6px; padding-left: 14px;
}
.tp-detail.open { display: block; }

/* Settings panel */
.settings-toggle {
  font-size: var(--text-small); font-weight: 500;
  font-family: var(--font-sans);
  padding: 5px 16px; border-radius: var(--radius-full);
  cursor: pointer; border: 1px solid var(--border-secondary);
  background: var(--bg-white); color: var(--fg-secondary);
  transition: background var(--duration-fast);
}
.settings-toggle:hover { background: var(--bg-tertiary); }
.settings-body {
  margin: 0 20px; padding: 0;
  display: flex; flex-direction: column; gap: 0;
  max-height: 300px; overflow: hidden;
  transition: max-height 0.2s ease, margin 0.2s ease, opacity 0.2s ease;
  opacity: 1;
}
.settings-body.collapsed { max-height: 0; margin-top: 0; margin-bottom: 0; opacity: 0; pointer-events: none; }
.settings-body:not(.collapsed) { margin-top: 12px; margin-bottom: 4px; }
.settings-card {
  background: var(--bg-white);
  border-radius: var(--radius-sm);
  border: 2px solid var(--sky);
  padding: 14px 16px;
  display: flex; flex-direction: column; gap: 12px;
}
.settings-header {
  display: flex; align-items: center; gap: 8px;
}
.settings-header svg { color: var(--sky); opacity: 0.85; flex-shrink: 0; }
.settings-header-text {
  font-size: var(--text-caption); font-weight: 600;
  color: var(--fg-tertiary); text-transform: uppercase;
  letter-spacing: 0.05em;
}
.settings-fields { display: flex; flex-direction: column; gap: 10px; }
.settings-field { display: flex; flex-direction: column; gap: 3px; }
.settings-label {
  font-size: var(--text-small); font-weight: 600;
  color: var(--fg-secondary);
}
.settings-input {
  font-size: var(--text-small); font-family: var(--font-sans);
  padding: 7px 10px; border: 1px solid var(--border-tertiary);
  border-radius: var(--radius-xs); background: var(--bg-secondary);
  color: var(--fg-primary); outline: none; resize: none;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.settings-input:focus { border-color: var(--clay); background: var(--bg-white); }
.settings-input::placeholder { color: var(--fg-tertiary); }

/* Chat */
.chat-section {
  margin-top: 16px; padding-top: 16px;
  border-top: 1px solid var(--border-tertiary);
}
.chat-pills {
  display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px;
}
.chat-pill {
  font-size: var(--text-small); font-family: var(--font-sans);
  color: var(--fg-primary); background: var(--bg-white);
  border: 1.5px solid var(--border-secondary); border-radius: var(--radius-full);
  padding: 6px 16px; cursor: pointer; font-weight: 500;
  transition: background var(--duration-fast);
}
.chat-pill:hover { background: var(--bg-secondary); }
.chat-messages {
  display: flex; flex-direction: column; gap: 8px;
  margin-bottom: 10px;
}
.chat-bubble {
  padding: 8px 12px; border-radius: 10px;
  font-size: var(--text-small); line-height: 1.5;
  max-width: 90%; word-break: break-word;
}
.chat-bubble.user {
  background: var(--sky); color: #fff;
  border-radius: 10px 10px 2px 10px;
  align-self: flex-end;
}
.chat-bubble.assistant {
  background: var(--bg-secondary); color: var(--fg-primary);
  border-radius: 10px 10px 10px 2px;
  align-self: flex-start;
}
.chat-bubble.typing { color: var(--fg-tertiary); }
.chat-bubble.assistant p { margin: 0 0 6px; }
.chat-bubble.assistant p:last-child { margin-bottom: 0; }
.chat-bubble.assistant ul { margin: 4px 0; padding-left: 18px; list-style: disc; }
.chat-bubble.assistant li { margin-bottom: 2px; }
.chat-bubble.assistant strong { font-weight: 600; }
.chat-input-row {
  display: flex; gap: 6px; align-items: flex-end;
}
.chat-input {
  flex: 1; font-size: 16px; font-family: var(--font-sans);
  padding: 6px 10px; border: 1px solid var(--border-tertiary);
  border-radius: 6px; background: var(--bg-white);
  color: var(--fg-primary); outline: none; resize: none;
  line-height: 1.4; overflow-y: hidden;
}
.chat-input:focus { border-color: var(--clay); }
.chat-input::placeholder { color: var(--fg-tertiary); }
.chat-send {
  background: var(--clay); color: #fff; border: none;
  border-radius: 6px; padding: 6px 14px;
  font-size: var(--text-small); font-weight: 500;
  cursor: pointer; font-family: var(--font-sans);
  transition: background var(--duration-fast);
}
.chat-send:hover { background: var(--accent-interactive); }
`;

// ── Button CSS (injected into host page) ──

const BUTTON_STYLE_ID = 'airglow-li-styles';

function injectButtonStyles() {
  if (document.getElementById(BUTTON_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = BUTTON_STYLE_ID;
  style.textContent = `
    #airglow-li-btn {
      position: fixed; z-index: 2147483646;
      right: 0; top: 75px;
      display: flex; align-items: center; gap: 6px;
      padding: 10px 16px 10px 12px;
      background: linear-gradient(135deg, #f8bb5b 0%, #e8a050 100%);
      border-radius: 12px 0 0 12px;
      box-shadow: -2px 0 12px rgba(232,160,80,0.3), 0 0 0 1px rgba(232,160,80,0.2);
      cursor: pointer;
      font-family: Inter, system-ui, -apple-system, sans-serif;
      transition: box-shadow .15s, filter .15s;
      user-select: none; line-height: 1;
    }
    #airglow-li-btn:hover {
      filter: brightness(1.05);
      box-shadow: -2px 0 20px rgba(232,160,80,0.4), 0 0 0 1px rgba(232,160,80,0.3);
    }
    #airglow-li-btn .ali-icon {
      flex-shrink: 0; width: 22px; height: 22px;
      display: flex; align-items: center; border-radius: 4px; overflow: hidden;
    }
    #airglow-li-btn .ali-label {
      font-size: 14px; color: #1a1a1a; font-weight: 500; white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}

// ── UI: Button ──

function createButton(): HTMLElement {
  const btn = document.createElement('div');
  btn.id = 'airglow-li-btn';
  btn.setAttribute('data-testid', 'li-research-btn');

  const icon = document.createElement('div');
  icon.className = 'ali-icon';
  icon.innerHTML = iconSvg.replace(/<svg /, '<svg width="20" height="20" style="border-radius:3px;" ');
  btn.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'ali-label';
  label.textContent = 'Research User';
  btn.appendChild(label);

  btn.addEventListener('click', togglePanel);
  return btn;
}

// ── UI: Shadow DOM Panel ──

function createPanel(): HTMLElement {
  const host = document.createElement('div');
  host.id = 'airglow-li-panel';
  const shadow = host.attachShadow({ mode: 'open' });
  shadowRoot = shadow;

  // Inject tokens CSS (replace :root with :host for shadow DOM)
  const tokenStyle = document.createElement('style');
  tokenStyle.textContent = tokensCSS.replace(/:root/g, ':host');
  shadow.appendChild(tokenStyle);

  // Inject panel CSS
  const panelStyle = document.createElement('style');
  panelStyle.textContent = PANEL_CSS;
  shadow.appendChild(panelStyle);

  // Panel background container
  const bg = document.createElement('div');
  bg.className = 'panel-bg';
  shadow.appendChild(bg);

  // Header
  const header = document.createElement('div');
  header.className = 'header';
  const title = document.createElement('span');
  title.className = 'header-title';
  title.setAttribute('data-testid', 'li-panel-title');
  title.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.8"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>Research';
  header.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'header-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn-pill';
  refreshBtn.setAttribute('data-testid', 'li-refresh');
  refreshBtn.textContent = '↻ Refresh';
  refreshBtn.style.display = 'none';
  refreshBtn.addEventListener('click', handleRefresh);
  actions.appendChild(refreshBtn);

  const hideBtn = document.createElement('button');
  hideBtn.className = 'btn-pill';
  hideBtn.setAttribute('data-testid', 'li-hide');
  hideBtn.textContent = 'Hide';
  hideBtn.addEventListener('click', () => {
    isOpen = false;
    host.classList.remove('ali-open');
    if (btnEl) btnEl.style.display = '';
  });
  actions.appendChild(hideBtn);

  const settingsToggle = document.createElement('button');
  settingsToggle.className = 'settings-toggle';
  settingsToggle.setAttribute('data-testid', 'li-settings-toggle');
  settingsToggle.textContent = '⚙ Goals';
  actions.appendChild(settingsToggle);

  header.appendChild(actions);
  bg.appendChild(header);

  // Settings panel
  const settingsBody = document.createElement('div');
  settingsBody.className = 'settings-body collapsed';
  settingsBody.setAttribute('data-testid', 'li-settings');

  const settingsCard = document.createElement('div');
  settingsCard.className = 'settings-card';

  // Card header
  const settingsHeader = document.createElement('div');
  settingsHeader.className = 'settings-header';
  settingsHeader.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>';
  const headerText = document.createElement('span');
  headerText.className = 'settings-header-text';
  headerText.textContent = 'Your Context';
  settingsHeader.appendChild(headerText);
  settingsCard.appendChild(settingsHeader);

  const fieldsWrap = document.createElement('div');
  fieldsWrap.className = 'settings-fields';

  const FIELDS: { key: string; label: string; placeholder: string; storageKey: string }[] = [
    { key: 'iam', label: 'I am', placeholder: 'Founder of Acme, building developer tools', storageKey: 'linkedin_user_iam' },
    { key: 'goal', label: 'Looking for', placeholder: 'VCs who invest in dev tools at seed stage', storageKey: 'linkedin_user_goal' },
    { key: 'notes', label: 'Notes', placeholder: 'Launching in Q3, team of 4', storageKey: 'linkedin_user_notes' },
  ];

  for (const f of FIELDS) {
    const field = document.createElement('div');
    field.className = 'settings-field';
    const label = document.createElement('label');
    label.className = 'settings-label';
    label.textContent = f.label;
    field.appendChild(label);
    const input = document.createElement('input');
    input.className = 'settings-input';
    input.setAttribute('data-testid', `li-${f.key}`);
    input.placeholder = f.placeholder;
    // Load saved value
    airglow.storage.get(f.storageKey).then((v: string) => { if (v) input.value = v; });
    // Save on change
    input.addEventListener('change', () => {
      airglow.storage.set(f.storageKey, input.value.trim());
    });
    field.appendChild(input);
    fieldsWrap.appendChild(field);
  }

  settingsCard.appendChild(fieldsWrap);
  settingsBody.appendChild(settingsCard);

  settingsToggle.addEventListener('click', () => {
    settingsBody.classList.toggle('collapsed');
    settingsToggle.textContent = settingsBody.classList.contains('collapsed') ? '⚙ Goals' : '⚙ Hide goals';
  });

  bg.appendChild(settingsBody);

  // Content area
  const content = document.createElement('div');
  content.className = 'content';
  content.setAttribute('data-testid', 'li-content');
  bg.appendChild(content);

  document.body.appendChild(host);
  return host;
}

// ── Rendering ──

function getContentEl(): HTMLElement | null {
  return shadowRoot?.querySelector('[data-testid="li-content"]') || null;
}

function getRefreshBtn(): HTMLElement | null {
  return shadowRoot?.querySelector('[data-testid="li-refresh"]') as HTMLElement | null;
}

function getTitleEl(): HTMLElement | null {
  return shadowRoot?.querySelector('[data-testid="li-panel-title"]') as HTMLElement | null;
}

function renderLoading(status: string) {
  const el = getContentEl();
  if (!el) return;
  el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'loading';
  wrap.innerHTML = `<div class="spinner"></div><span class="loading-text">${status}</span>`;
  el.appendChild(wrap);

  const btn = getRefreshBtn();
  if (btn) btn.style.display = 'none';
}

function renderError(msg: string) {
  const el = getContentEl();
  if (!el) return;
  el.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'error-text';
  div.textContent = msg;
  el.appendChild(div);
}

function renderResult(result: ResearchResult, profile: ScrapedProfile) {
  const el = getContentEl();
  if (!el) return;
  el.innerHTML = '';

  const titleEl = getTitleEl();
  // Title stays as "Research" — name is in the hero card

  const btn = getRefreshBtn();
  if (btn) btn.style.display = '';

  const data = result.structured;
  if (!data) {
    const p = document.createElement('div');
    p.className = 'loading-text';
    p.textContent = result.text || 'No results found.';
    el.appendChild(p);
    return;
  }

  const sections = document.createElement('div');
  sections.className = 'sections';

  // Hero card (with person_summary + tldr)
  sections.appendChild(buildHeroCard(profile, data));

  // Talking points (expandable items)
  const talkingPoints: { text: string; detail?: string }[] = (data.talking_points || []).map((item: any) =>
    typeof item === 'string' ? { text: item } : item
  );
  if (talkingPoints.length > 0) {
    sections.appendChild(buildTalkingPoints(talkingPoints, SECTION_META.talking_points.color));
  }

  // Quick reference + Recent activity side by side
  const qr: EntryData[] = (data.quick_reference || []).map((item: any) =>
    typeof item === 'object' && item?.title ? item : { title: String(item) }
  );
  const ra: (EntryData & { date?: string })[] = (data.recent_activity || []).map((item: any) =>
    typeof item === 'object' && item?.title ? item : { title: String(item) }
  );
  if (qr.length > 0 || ra.length > 0) {
    const grid = document.createElement('div');
    grid.className = 'two-col';
    if (qr.length > 0) grid.appendChild(buildSectionCard('Quick Reference', qr, SECTION_META.quick_reference.color));
    if (ra.length > 0) grid.appendChild(buildSectionCard('Recent Activity', ra, SECTION_META.recent_activity.color));
    sections.appendChild(grid);
  }

  // Chat section
  sections.appendChild(buildChatSection(result, profile));

  el.appendChild(sections);
}

function buildHeroCard(profile: ScrapedProfile, data: Record<string, any>): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card hero';

  const name = document.createElement('h1');
  name.className = 'hero-name';
  name.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  name.appendChild(document.createTextNode(profile.name));
  card.appendChild(name);

  // Person summary from research
  const ps = data.person_summary;
  if (ps) {
    const summary = document.createElement('div');
    summary.className = 'hero-summary';
    const parts: string[] = [];
    if (ps.current_role) parts.push(ps.current_role);
    if (ps.location) parts.push(ps.location);
    if (ps.joined) parts.push(`since ${ps.joined}`);
    if (ps.age_approx) parts.push(ps.age_approx);
    summary.textContent = parts.join(' · ');
    card.appendChild(summary);
  } else {
    // Fallback to scraped data
    const meta = [profile.headline, profile.location].filter(Boolean).join(' · ');
    if (meta) {
      const p = document.createElement('div');
      p.className = 'hero-summary';
      p.textContent = meta;
      card.appendChild(p);
    }
  }

  if (data.tldr) {
    const tldrItems: { label: string; text: string }[] = Array.isArray(data.tldr)
      ? data.tldr.map((item: any) => typeof item === 'string' ? { label: '', text: item } : item)
      : [{ label: '', text: data.tldr }];
    const ul = document.createElement('ul');
    ul.className = 'hero-tldr';
    for (const item of tldrItems) {
      const li = document.createElement('li');
      if (item.label) {
        const b = document.createElement('strong');
        b.textContent = item.label + ': ';
        li.appendChild(b);
        li.appendChild(document.createTextNode(item.text));
      } else {
        li.textContent = item.text;
      }
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }

  return card;
}

const SECTION_ICONS: Record<string, string> = {
  'Talking Points': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  'Quick Reference': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>',
  'Recent Activity': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
};

function buildSectionCard(title: string, entries: EntryData[], color: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.className = 'section-header';
  const label = document.createElement('div');
  label.className = 'section-label';
  const icon = SECTION_ICONS[title] || '';
  label.innerHTML = `<div class="section-dot" style="background:${color}"></div>${icon}`;
  const t = document.createElement('h3');
  t.className = 'section-title';
  t.textContent = title;
  label.appendChild(t);
  header.appendChild(label);

  const count = document.createElement('span');
  count.className = 'section-count';
  count.textContent = String(entries.length);
  header.appendChild(count);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'section-body';
  for (const entry of entries) {
    body.appendChild(buildEntryRow(entry, color));
  }
  card.appendChild(body);

  return card;
}

function buildEntryRow(entry: EntryData & { date?: string }, color: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'entry';
  const inner = document.createElement('div');
  inner.className = 'entry-row';

  inner.innerHTML = `<div class="entry-dot" style="background:${color}"></div>`;
  const content = document.createElement('div');
  content.className = 'entry-content';

  const title = document.createElement('div');
  title.className = 'entry-title';
  title.textContent = entry.title;
  content.appendChild(title);

  if (entry.subtitle) {
    const sub = document.createElement('div');
    sub.className = 'entry-subtitle';
    sub.textContent = entry.subtitle;
    content.appendChild(sub);
  }

  inner.appendChild(content);

  if (entry.date) {
    const dateEl = document.createElement('div');
    dateEl.className = 'entry-date';
    dateEl.textContent = entry.date;
    inner.appendChild(dateEl);
  }

  row.appendChild(inner);
  return row;
}

function buildBulletList(title: string, items: string[], color: string, collapsible = false): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.className = 'section-header' + (collapsible ? ' clickable' : '');
  const label = document.createElement('div');
  label.className = 'section-label';
  label.innerHTML = `<div class="section-dot" style="background:${color}"></div>`;
  const t = document.createElement('h3');
  t.className = 'section-title';
  t.textContent = title;
  label.appendChild(t);
  header.appendChild(label);

  const body = document.createElement('div');
  body.className = 'section-body';

  if (collapsible) {
    const chevron = document.createElement('span');
    chevron.className = 'section-chevron';
    chevron.textContent = '▾';
    header.appendChild(chevron);
    header.addEventListener('click', () => {
      body.classList.toggle('collapsed');
      chevron.classList.toggle('collapsed');
    });
  }

  card.appendChild(header);

  for (const text of items) {
    const row = document.createElement('div');
    row.className = 'entry';
    const inner = document.createElement('div');
    inner.className = 'entry-row';
    inner.innerHTML = `<div class="entry-dot" style="background:${color}"></div>`;
    const span = document.createElement('div');
    span.className = 'entry-title';
    span.style.fontWeight = '500';
    span.textContent = text;
    inner.appendChild(span);
    row.appendChild(inner);
    body.appendChild(row);
  }
  card.appendChild(body);
  return card;
}

function buildTalkingPoints(items: { text: string; detail?: string }[], color: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.className = 'section-header clickable';
  const label = document.createElement('div');
  label.className = 'section-label';
  label.innerHTML = `<div class="section-dot" style="background:${color}"></div>${SECTION_ICONS['Talking Points'] || ''}`;
  const t = document.createElement('h3');
  t.className = 'section-title';
  t.textContent = 'Talking Points';
  label.appendChild(t);
  header.appendChild(label);

  const sectionChevron = document.createElement('span');
  sectionChevron.className = 'section-chevron';
  sectionChevron.textContent = '▾';
  header.appendChild(sectionChevron);

  const body = document.createElement('div');
  body.className = 'section-body';

  header.addEventListener('click', () => {
    body.classList.toggle('collapsed');
    sectionChevron.classList.toggle('collapsed');
  });

  card.appendChild(header);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'tp-item';

    const top = document.createElement('div');
    top.className = 'tp-row';
    top.innerHTML = `<div class="entry-dot" style="background:${color}"></div>`;

    const text = document.createElement('div');
    text.className = 'tp-text';
    text.textContent = item.text;
    top.appendChild(text);

    const arrow = document.createElement('span');
    arrow.className = 'tp-arrow';
    arrow.textContent = '›';
    top.appendChild(arrow);

    row.appendChild(top);

    if (item.detail) {
      const detail = document.createElement('div');
      detail.className = 'tp-detail';
      detail.textContent = item.detail;
      row.appendChild(detail);

      row.addEventListener('click', () => {
        arrow.classList.toggle('open');
        detail.classList.toggle('open');
      });
    }

    body.appendChild(row);
  }

  card.appendChild(body);
  return card;
}

// ── Chat ──

interface ChatMsg { role: 'user' | 'assistant'; text: string }
let chatMessages: ChatMsg[] = [];
let chatApiMessages: { role: string; content: any }[] = [];
let chatLoading = false;

function buildChatSection(result: ResearchResult, profile: ScrapedProfile): HTMLElement {
  const section = document.createElement('div');
  section.className = 'chat-section';
  section.setAttribute('data-testid', 'li-chat');

  // Suggested question pills
  const questions = result.suggestedQuestions || [];
  if (questions.length > 0) {
    const pillsWrap = document.createElement('div');
    pillsWrap.className = 'chat-pills';
    for (const q of questions) {
      const pill = document.createElement('button');
      pill.className = 'chat-pill';
      pill.textContent = q;
      pill.addEventListener('click', () => {
        sendChatMessage(q, result, profile, section);
      });
      pillsWrap.appendChild(pill);
    }
    section.appendChild(pillsWrap);
  }

  // Messages area
  const messagesEl = document.createElement('div');
  messagesEl.className = 'chat-messages';
  messagesEl.setAttribute('data-testid', 'li-chat-messages');
  section.appendChild(messagesEl);

  // Input row
  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';

  const input = document.createElement('textarea');
  input.className = 'chat-input';
  input.setAttribute('data-testid', 'li-chat-input');
  input.rows = 1;
  input.placeholder = 'Ask about this person...';
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    input.style.overflowY = input.scrollHeight > 100 ? 'auto' : 'hidden';
  });

  const sendBtn = document.createElement('button');
  sendBtn.className = 'chat-send';
  sendBtn.setAttribute('data-testid', 'li-chat-send');
  sendBtn.textContent = 'Send';

  const doSend = () => {
    const q = input.value.trim();
    if (!q || chatLoading) return;
    input.value = '';
    input.style.height = 'auto';
    sendChatMessage(q, result, profile, section);
  };

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  sendBtn.addEventListener('click', doSend);

  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);
  section.appendChild(inputRow);

  return section;
}

function renderChatMessages(section: HTMLElement) {
  const messagesEl = section.querySelector('[data-testid="li-chat-messages"]');
  if (!messagesEl) return;
  messagesEl.innerHTML = '';

  for (const msg of chatMessages) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${msg.role}`;
    if (msg.role === 'assistant') {
      bubble.innerHTML = renderMarkdown(msg.text);
    } else {
      bubble.textContent = msg.text;
    }
    messagesEl.appendChild(bubble);
  }

  if (chatLoading) {
    const dot = document.createElement('div');
    dot.className = 'chat-bubble assistant typing';
    dot.textContent = '…';
    messagesEl.appendChild(dot);
  }

  // Scroll content area to bottom
  const contentEl = getContentEl();
  if (contentEl) contentEl.scrollTop = contentEl.scrollHeight;
}

async function sendChatMessage(
  question: string,
  result: ResearchResult,
  profile: ScrapedProfile,
  section: HTMLElement,
) {
  // Hide pills after first interaction
  const pills = section.querySelector('.chat-pills');
  if (pills) pills.remove();

  chatMessages.push({ role: 'user', text: question });
  chatLoading = true;
  renderChatMessages(section);

  try {
    // Build system prompt for chat on first message
    if (chatApiMessages.length === 0) {
      const userGoal = await loadUserGoal();
      const systemParts = [
        `You researched ${profile.name}. The user wants to ask follow-up questions.`,
        `Research result: ${JSON.stringify(result.structured)}`,
      ];
      if (userGoal.iam) systemParts.push(`User context: ${userGoal.iam}`);
      if (userGoal.goal) systemParts.push(`User goal: ${userGoal.goal}`);
      systemParts.push('Answer briefly — use bullet points and bold labels (**Label:** detail). Keep responses under 5 bullet points. If you don\'t have the info, say so.');

      // Store system prompt as first element for reference
      chatApiMessages.push({ role: 'system', content: systemParts.join('\n') });
    }

    chatApiMessages.push({ role: 'user', content: question });

    // Extract system message and conversation messages
    const systemContent = chatApiMessages[0].content;
    const messages = chatApiMessages.slice(1);

    const data = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemContent,
      messages,
    });

    let responseText = '';
    for (const block of data.content || []) {
      if (block.type === 'text') responseText += block.text;
    }

    chatApiMessages.push({ role: 'assistant', content: responseText });
    chatMessages.push({ role: 'assistant', text: responseText });
  } catch (e: any) {
    chatMessages.push({ role: 'assistant', text: `Error: ${e.message}` });
    airglow.log.error('linkedin', `chat error: ${e.message}`);
  }

  chatLoading = false;
  renderChatMessages(section);
}

// ── Panel logic ──

let currentProfile: ScrapedProfile | null = null;

async function loadResearch(profile: ScrapedProfile) {
  currentProfile = profile;
  chatMessages = [];
  chatApiMessages = [];
  chatLoading = false;
  renderLoading(`Researching ${profile.name}...`);

  const key = cacheKey(profile.profileUrl);
  airglow.log.info('linkedin', `checking cache — ${key}`);

  try {
    const cached = await airglow.storage.get(key);
    if (cached) {
      airglow.log.info('linkedin', 'cache hit');
      renderResult(cached, profile);
      return;
    }

    airglow.log.info('linkedin', 'no cache, starting research');
    const result = await runResearch(profile);
    airglow.log.info('linkedin', `result — structured: ${!!result.structured}`);
    await airglow.storage.set(key, result);
    renderResult(result, profile);
  } catch (e: any) {
    airglow.log.error('linkedin', `research failed: ${e.message}`);
    renderError(e.message || 'Research failed');
  }
}

async function handleRefresh() {
  if (!currentProfile) return;
  await airglow.storage.delete(cacheKey(currentProfile.profileUrl));
  await loadResearch(currentProfile);
}

async function togglePanel() {
  isOpen = !isOpen;

  if (isOpen) {
    const profile = scrapeProfile();
    airglow.log.info('linkedin', `scraped profile: ${profile.name}`);

    if (!panelHost) {
      panelHost = createPanel();
    }

    panelHost.classList.add('ali-open');
    if (btnEl) btnEl.style.display = 'none';

    // Load research (or re-load if different profile)
    if (!currentProfile || currentProfile.profileUrl !== profile.profileUrl) {
      await loadResearch(profile);
    }
  } else {
    panelHost?.classList.remove('ali-open');
    if (btnEl) btnEl.style.display = '';
  }
}

// ── Init ──

async function inject() {
  if (document.getElementById('airglow-li-btn')) return;
  if (!window.location.pathname.match(/^\/in\/[^/]+/)) return;

  injectButtonStyles();
  btnEl = createButton();
  document.body.appendChild(btnEl);
}

function cleanup() {
  panelHost?.remove();
  panelHost = null;
  shadowRoot = null;
  btnEl?.remove();
  btnEl = null;
  isOpen = false;
  currentProfile = null;
}

function init() {
  inject();

  // LinkedIn SPA: poll for URL changes (pushState override doesn't work —
  // LinkedIn captures the original before our userscript runs)
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      cleanup();
      setTimeout(inject, 1000);
    }
  }, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
