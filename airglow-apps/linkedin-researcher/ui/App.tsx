import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import Anthropic from '@anthropic-ai/sdk';

declare const airglow: any;

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

interface ResearchResult {
  structured: Record<string, any> | null;
  text: string;
}

// ── Schema ──

const ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Primary label — company, project, or fact name' },
    subtitle: { type: 'string', description: 'Secondary detail — role, date range, or context' },
    detail: { type: 'string', description: 'One sentence of additional context (optional)' },
  },
  required: ['title'],
};

const DEFAULT_SCHEMA: any = {
  type: 'object',
  properties: {
    tldr: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '1-3 word label' },
          text: { type: 'string', description: 'One sentence expanding the label' },
        },
        required: ['label', 'text'],
      },
      description: '2-4 bullet points with short label + explanation',
    },
    background: {
      type: 'array',
      items: ENTRY_SCHEMA,
      description: 'Career trajectory — key roles and companies (3-5 entries)',
    },
    portfolio: {
      type: 'array',
      items: ENTRY_SCHEMA,
      description: 'Notable work — companies built, products, investments, publications (3-5 entries)',
    },
    notable: {
      type: 'array',
      items: ENTRY_SCHEMA,
      description: 'Interesting facts from web — news, awards, side projects (2-4 entries)',
    },
  },
  required: ['tldr', 'background', 'portfolio', 'notable'],
};

// ── Helpers ──

function cacheKey(url: string): string {
  const slug = url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '');
  return `linkedin_research_${slug}`;
}

function buildPrompt(profile: ScrapedProfile): string {
  return [
    `Research this person thoroughly using web search.`,
    ``,
    `Name: ${profile.name}`,
    `LinkedIn: ${profile.profileUrl}`,
    profile.headline ? `Headline: ${profile.headline}` : '',
    profile.location ? `Location: ${profile.location}` : '',
    profile.about ? `\nAbout:\n${profile.about}` : '',
    profile.experience.length ? `\nExperience:\n${profile.experience.map(e => `- ${e}`).join('\n')}` : '',
    profile.education.length ? `\nEducation:\n${profile.education.map(e => `- ${e}`).join('\n')}` : '',
    ``,
    `Search the web for additional information beyond their LinkedIn. Look for:`,
    `- Companies built, products shipped, investments`,
    `- News, interviews, publications, talks`,
    `- Awards, board positions, open source contributions`,
    ``,
    `After researching, call the research_output tool with findings structured per its schema.`,
    `Each entry has title (bold label), subtitle (context/dates), and optional detail (one sentence).`,
    `Keep titles under 8 words, subtitles under 10 words. Be factual — no filler.`,
  ].filter(Boolean).join('\n');
}

// ── Section config ──

const SECTION_META: Record<string, { color: string; icon: string }> = {
  background: { color: 'var(--sky)', icon: '~' },
  portfolio: { color: 'var(--olive)', icon: '~' },
  notable: { color: 'var(--fig)', icon: '~' },
};
const FALLBACK_COLORS = ['var(--sky)', 'var(--olive)', 'var(--fig)', 'var(--plum)', 'var(--mineral)'];

// ── Components ──

function Spinner() {
  return (
    <div className="w-4 h-4 border-2 border-stone-200 border-t-[var(--clay)] rounded-full animate-spin" />
  );
}

function HeroCard({ profile, tldr }: { profile: ScrapedProfile; tldr?: any }) {
  const meta = [profile.headline, profile.location].filter(Boolean).join(' · ');
  const tldrItems: { label: string; text: string }[] = tldr
    ? (Array.isArray(tldr) ? tldr : [tldr]).map((item: any) =>
        typeof item === 'string' ? { label: '', text: item } : item)
    : [];
  return (
    <div className="bg-white border border-stone-200 rounded-md p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <h1 className="text-xl font-bold text-stone-900">{profile.name}</h1>
      {meta && <p className="text-sm text-stone-500 mt-0.5">{meta}</p>}
      {tldrItems.length > 0 && (
        <ul className="text-sm text-stone-600 mt-3 pl-5 leading-relaxed list-disc">
          {tldrItems.map((item, i) => (
            <li key={i}>
              {item.label && <strong>{item.label}: </strong>}
              {item.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryRow({ entry, color }: { entry: EntryData; color: string }) {
  return (
    <div className="py-2 border-b border-stone-100 last:border-b-0">
      <div className="flex items-start gap-2">
        <div className="w-1.5 h-1.5 rounded-full mt-2 shrink-0" style={{ background: color }} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-stone-800 leading-snug">{entry.title}</div>
          {entry.subtitle && (
            <div className="text-xs text-stone-500 mt-0.5">{entry.subtitle}</div>
          )}
          {entry.detail && (
            <div className="text-xs text-stone-600 mt-1 leading-relaxed">{entry.detail}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionCard({ title, entries, color, count }: {
  title: string; entries: EntryData[]; color: string; count?: number;
}) {
  return (
    <div className="bg-white border border-stone-200 rounded-md overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="px-4 pt-3 pb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: color }} />
          <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wider">{title}</h3>
        </div>
        {count != null && (
          <span className="text-xs text-stone-400">{count}</span>
        )}
      </div>
      <div className="px-4 pb-3">
        {entries.map((entry, i) => (
          <EntryRow key={i} entry={entry} color={color} />
        ))}
      </div>
    </div>
  );
}

function PortfolioCard({ entry, color }: { entry: EntryData; color: string }) {
  return (
    <div className="bg-white border border-stone-200 rounded-md p-3" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="text-sm font-semibold text-stone-800 leading-snug truncate">{entry.title}</div>
      {entry.subtitle && (
        <div className="text-xs text-stone-500 mt-0.5 truncate">{entry.subtitle}</div>
      )}
    </div>
  );
}

function PortfolioSection({ entries, color }: { entries: EntryData[]; color: string }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? entries : entries.slice(0, 6);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-2 h-2 rounded-full" style={{ background: color }} />
        <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wider">Portfolio</h3>
        <span className="text-xs text-stone-400">{entries.length}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {visible.map((entry, i) => (
          <PortfolioCard key={i} entry={entry} color={color} />
        ))}
      </div>
      {entries.length > 6 && (
        <button
          className="text-xs text-stone-500 mt-2 hover:text-stone-700 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : `Show all ${entries.length}`}
        </button>
      )}
    </div>
  );
}

function ResearchContent({ result, profile }: { result: ResearchResult; profile: ScrapedProfile }) {
  const data = result.structured;
  if (!data) {
    return <p className="text-sm text-stone-500">{result.text || 'No results found.'}</p>;
  }

  // Extract sections
  const tldr = data.tldr as string | undefined;
  const sections: { key: string; entries: EntryData[]; color: string }[] = [];
  let idx = 0;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'tldr' || !Array.isArray(value)) continue;
    const color = SECTION_META[key]?.color || FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
    const entries: EntryData[] = value.map((item: any) =>
      typeof item === 'object' && item?.title ? item : { title: String(item) }
    );
    sections.push({ key, entries, color });
    idx++;
  }

  const background = sections.find(s => s.key === 'background');
  const notable = sections.find(s => s.key === 'notable');
  const portfolio = sections.find(s => s.key === 'portfolio');
  const other = sections.filter(s => !['background', 'notable', 'portfolio'].includes(s.key));

  return (
    <div className="flex flex-col gap-4">
      <HeroCard profile={profile} tldr={tldr} />

      {/* 2-column: Background + Notable */}
      {(background || notable) && (
        <div className="grid grid-cols-2 gap-3">
          {background && (
            <SectionCard
              title="Background"
              entries={background.entries}
              color={background.color}
              count={background.entries.length}
            />
          )}
          {notable && (
            <SectionCard
              title="Notable"
              entries={notable.entries}
              color={notable.color}
              count={notable.entries.length}
            />
          )}
        </div>
      )}

      {/* Portfolio grid */}
      {portfolio && (
        <PortfolioSection entries={portfolio.entries} color={portfolio.color} />
      )}

      {/* Other custom sections */}
      {other.map(s => (
        <SectionCard
          key={s.key}
          title={s.key.replace(/_/g, ' ')}
          entries={s.entries}
          color={s.color}
          count={s.entries.length}
        />
      ))}

      {/* Non-array fields */}
      {Object.entries(data)
        .filter(([k, v]) => k !== 'tldr' && !Array.isArray(v))
        .map(([k, v]) => (
          <div key={k}>
            <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">
              {k.replace(/_/g, ' ')}
            </h3>
            <p className="text-sm text-stone-600 leading-relaxed">{String(v)}</p>
          </div>
        ))
      }
    </div>
  );
}

// ── Main App ──

function App() {
  const [profile, setProfile] = useState<ScrapedProfile | null>(null);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('Loading...');
  const [error, setError] = useState('');

  useEffect(() => {
    // Delay init slightly to let the SDK postMessage bridge establish
    const t = setTimeout(init, 500);
    return () => clearTimeout(t);
  }, []);

  async function init() {
    airglow.log.info('linkedin', 'step 1: loading profile from storage');
    const p = await airglow.storage.get('linkedin_current_profile');
    if (!p) {
      setLoading(false);
      setError('No profile data found.');
      airglow.log.error('linkedin', 'no profile in storage');
      return;
    }
    airglow.log.info('linkedin', `step 2: profile loaded — ${p.name}`);
    setProfile(p);
    await loadResearch(p);
  }

  async function loadResearch(p: ScrapedProfile) {
    setLoading(true);
    setError('');

    // Check cache
    const key = cacheKey(p.profileUrl);
    airglow.log.info('linkedin', `step 3: checking cache — ${key}`);
    const cached = await airglow.storage.get(key);
    if (cached) {
      airglow.log.info('linkedin', 'step 3a: cache hit');
      setResult(cached);
      setLoading(false);
      return;
    }

    airglow.log.info('linkedin', 'step 4: no cache, starting research');
    setStatus(`Researching ${p.name}...`);

    try {
      const apiKey = await airglow.storage.get('ANTHROPIC_API_KEY');
      if (!apiKey) throw new Error('Missing API key — set ANTHROPIC_API_KEY in app settings');
      airglow.log.info('linkedin', 'step 5: API key loaded');

      const schema = (await airglow.storage.get('linkedin_output_schema')) || DEFAULT_SCHEMA;
      const parsedSchema = typeof schema === 'string' ? JSON.parse(schema) : schema;

      const prompt = buildPrompt(p);
      airglow.log.info('linkedin', `step 6: calling Claude API — prompt length: ${prompt.length}`);

      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        tools: [
          { type: 'web_search_20250305' as any, name: 'web_search', max_uses: 5 },
          { name: 'research_output', description: 'Output structured research results', input_schema: parsedSchema },
        ],
        messages: [{ role: 'user', content: prompt }],
      });

      airglow.log.info('linkedin', `step 7: API response — ${message.content.length} blocks, stop: ${message.stop_reason}`);

      let structured: Record<string, any> | null = null;
      let text = '';
      for (const block of message.content) {
        if (block.type === 'tool_use' && block.name === 'research_output') {
          structured = block.input as Record<string, any>;
        } else if (block.type === 'text') {
          text += block.text;
        }
      }

      const res: ResearchResult = { structured, text };
      airglow.log.info('linkedin', `step 8: result — structured: ${!!structured}, keys: ${structured ? Object.keys(structured).join(',') : 'none'}`);
      await airglow.storage.set(key, res);
      setResult(res);
    } catch (e: any) {
      setError(e.message || 'Research failed');
      airglow.log.error('linkedin research failed', { error: e.message, stack: e.stack });
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    if (!profile) return;
    await airglow.storage.delete(cacheKey(profile.profileUrl));
    setResult(null);
    await loadResearch(profile);
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-stone-50 border-b border-stone-200 px-5 py-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-stone-800">
          Research{profile ? ` · ${profile.name}` : ''}
        </h2>
        <div className="flex items-center gap-2">
          {!loading && result && (
            <button
              onClick={handleRefresh}
              className="text-xs text-stone-500 border border-stone-200 rounded-full px-3 py-1 hover:bg-stone-100 cursor-pointer font-medium"
            >
              ↻ Refresh
            </button>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="p-5">
        {loading && (
          <div className="flex items-center gap-3 py-8 justify-center">
            <Spinner />
            <span className="text-sm text-stone-500">{status}</span>
          </div>
        )}

        {error && !loading && (
          <div className="text-sm text-[var(--error)] py-4">{error}</div>
        )}

        {!loading && result && profile && (
          <ResearchContent result={result} profile={profile} />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
