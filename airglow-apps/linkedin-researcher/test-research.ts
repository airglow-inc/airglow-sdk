/**
 * Cross-profile research test.
 * Runs 3 user personas × 2 LinkedIn profiles = 6 API calls.
 * Outputs side-by-side to verify personalization quality.
 *
 * Usage: npx tsx airglow-apps/linkedin-app/test-research.ts
 */

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// ── User personas ──

const PERSONAS = [
  {
    name: 'Founder (dev tools)',
    iam: 'Founder of a dev tools startup building AI code review',
    goal: 'Raising seed round, looking for VCs who invest in dev tools / AI',
    notes: 'Team of 4, launching in Q3',
  },
  {
    name: 'Recruiter (senior eng)',
    iam: 'Technical recruiter at a Series B AI company',
    goal: 'Hiring senior engineers and engineering leaders',
    notes: 'Remote-friendly, competitive comp',
  },
  {
    name: 'BD lead (partnerships)',
    iam: 'BD lead at an enterprise SaaS company',
    goal: 'Looking for partnership opportunities with VCs and accelerators',
    notes: 'Focus on enterprise security and compliance',
  },
];

// ── Scraped profiles (from LinkedIn) ──

const PROFILES = [
  {
    name: 'Alice Example',
    headline: 'General Partner @ Example Capital',
    location: 'San Francisco Bay Area',
    about: '',
    experience: ['General Partner @ Example Capital', 'Co-Founder @ ExampleCo'],
    education: ['Example University'],
    profileUrl: 'https://www.linkedin.com/in/alice-example/',
  },
  {
    name: 'Bob Sample',
    headline: 'Sample Ventures',
    location: 'United States',
    about: '',
    experience: ['Sample Ventures', 'Venture Partner, Sample Partners'],
    education: ['Example University'],
    profileUrl: 'https://www.linkedin.com/in/bob-sample/',
  },
];

// ── Schema (must match linkedin.ts) ──

const REF_ITEM = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Fact label — under 6 words' },
    subtitle: { type: 'string', description: 'Brief context — under 8 words' },
  },
  required: ['title'],
};

const RESEARCH_SCHEMA = {
  type: 'object' as const,
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
      description: '2-4 bullet points with short label + explanation. Relevance briefing, not a bio.',
    },
    talking_points: {
      type: 'array',
      items: { type: 'string' },
      description: '3-4 one-line conversation openers tailored to the user\'s goal. Each under 15 words. Actionable — things to ask or mention, not facts.',
    },
    quick_reference: {
      type: 'array',
      items: REF_ITEM,
      description: 'Compact career facts: current role, past key roles, education. Max 4 entries. Title=fact, subtitle=context. No paragraphs.',
    },
    recent_activity: {
      type: 'array',
      items: REF_ITEM,
      description: 'What they\'re doing NOW — recent news, posts, launches, investments, talks from the last 1-2 years. Max 3 entries.',
    },
    suggested_questions: {
      type: 'array',
      items: { type: 'string' },
      description: '3 follow-up questions the user might ask about this person (max 50 chars each)',
    },
  },
  required: ['tldr', 'talking_points', 'quick_reference', 'recent_activity', 'suggested_questions'],
};

// ── Prompt builders (same as linkedin.ts) ──

function buildSystemPrompt(persona: typeof PERSONAS[0]): string {
  return [
    'You produce a compact research briefing about a person, personalized for the user\'s goals. This is a sidebar panel — space is limited. Every word must earn its place.',
    '',
    '## Who is reading this',
    `I am: ${persona.iam}`,
    `Looking for: ${persona.goal}`,
    `Notes: ${persona.notes}`,
    '',
    '## Output rules',
    '- TLDR: 2-3 sentences max. Not a bio. A relevance briefing — who they are and why the user should care. If not relevant, say so directly.',
    '- Talking points: 3-4 one-liners the user can actually say in conversation. Under 15 words each. "Ask about X" or "Mention Y" format.',
    '- Quick reference: max 4 entries. Current role, 1-2 past roles, education. Title under 6 words, subtitle under 8 words. NO detail paragraphs.',
    '- Recent activity: max 3 entries. News, investments, launches, talks from the last 1-2 years. If nothing recent found, return empty array.',
    '- Suggested questions: 3 follow-ups (max 50 chars each).',
    '- DO NOT pad sections. If there are only 2 relevant talking points, return 2. Empty sections are fine.',
    '- DO NOT write paragraphs or multi-sentence details. This is a quick-glance reference card.',
  ].join('\n');
}

function buildUserMessage(profile: typeof PROFILES[0]): string {
  return [
    'Research this person:',
    '',
    `Name: ${profile.name}`,
    `LinkedIn: ${profile.profileUrl}`,
    `Headline: ${profile.headline}`,
    `Location: ${profile.location}`,
    profile.experience.length ? `Experience: ${profile.experience.join(', ')}` : '',
    profile.education.length ? `Education: ${profile.education.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

// ── Run ──

async function runOne(persona: typeof PERSONAS[0], profile: typeof PROFILES[0]) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: buildSystemPrompt(persona),
    tools: [
      { type: 'web_search_20250305' as any, name: 'web_search', max_uses: 3 },
      { name: 'research_output', description: 'Output structured research results', input_schema: RESEARCH_SCHEMA },
    ],
    messages: [{ role: 'user', content: buildUserMessage(profile) }],
  });

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'research_output') {
      return block.input as Record<string, any>;
    }
  }
  return null;
}

async function main() {
  console.log('Running 3 personas × 2 profiles = 6 research calls...\n');

  for (const profile of PROFILES) {
    console.log('═'.repeat(80));
    console.log(`PROFILE: ${profile.name} — ${profile.headline}`);
    console.log('═'.repeat(80));

    for (const persona of PERSONAS) {
      console.log(`\n── ${persona.name} ──`);
      try {
        const result = await runOne(persona, profile);
        if (!result) { console.log('  (no structured output)'); continue; }

        console.log(`  TLDR: ${result.tldr}`);

        if (result.talking_points?.length) {
          console.log('  TALKING POINTS:');
          for (const tp of result.talking_points) console.log(`    • ${tp}`);
        }

        if (result.quick_reference?.length) {
          console.log('  QUICK REF:');
          for (const r of result.quick_reference) console.log(`    ${r.title}${r.subtitle ? ' — ' + r.subtitle : ''}`);
        }

        if (result.recent_activity?.length) {
          console.log('  RECENT:');
          for (const r of result.recent_activity) console.log(`    ${r.title}${r.subtitle ? ' — ' + r.subtitle : ''}`);
        }

        if (result.suggested_questions?.length) {
          console.log('  QUESTIONS:');
          for (const q of result.suggested_questions) console.log(`    ? ${q}`);
        }
      } catch (e: any) {
        console.log(`  ERROR: ${e.message}`);
      }
    }
    console.log();
  }
}

main();
