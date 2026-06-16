// System prompt sourcing. SINGLE source of truth:
// airglow-cloud/lib/agent-system-prompt.md.
//
// - Gateway mode (production): the host sends NO canonical prompt at all —
//   the gateway injects it server-side into /api/agent/messages. The host
//   contributes only the machine-local runtime context below.
// - Direct-API dev mode (ANTHROPIC_API_KEY set): the host reads the same .md
//   file from disk via AIRGLOW_AGENT_PROMPT_FILE (point it at your
//   airglow-cloud checkout, e.g. in ~/.airglow/state/agent.env).

import { readFileSync } from 'node:fs';

// '' in gateway mode (server injects); file content in dev mode.
export function getSystemPromptPrefix(): string {
  if (!process.env.ANTHROPIC_API_KEY) return '';
  const path = process.env.AIRGLOW_AGENT_PROMPT_FILE;
  if (!path) {
    throw new Error(
      'direct-API mode needs AIRGLOW_AGENT_PROMPT_FILE pointing at airglow-cloud/lib/agent-system-prompt.md (set it in ~/.airglow/state/agent.env)',
    );
  }
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (text.length < 200) throw new Error('file too short');
    return text;
  } catch (e: any) {
    throw new Error(`could not read agent prompt from ${path}: ${e?.message ?? e}`);
  }
}

// Machine-local facts, appended after the canonical prompt (by the gateway in
// production, locally in dev mode).
export function promptRuntimeContext(opts: {
  workspace: string;
  daemonOrigin: string;
  daemonLogPath: string;
  apps: { id: string; dir: string }[];
}): string {
  const appsList = opts.apps.length
    ? opts.apps.map((a) => `  - ${a.id} → ${a.dir}/`).join('\n')
    : '  (none yet)';
  const newAppHint = opts.apps.length
    ? `Create new apps as siblings of the existing ones (same parent directory pattern).`
    : `Create new apps under apps/<id>/.`;
  return `
# Environment

- Workspace root (your cwd): ${opts.workspace}
- Local app server (the Airglow daemon): ${opts.daemonOrigin}
- Daemon log (bundle errors, RPC failures): ${opts.daemonLogPath}
- Current date: ${new Date().toISOString().slice(0, 10)}
- Existing apps (id → directory):
${appsList}
- ${newAppHint}
- Screenshots: when \`airglow browser shot\` prints a saved image path, the
  image is automatically attached to that tool result — you see it without a
  separate read step (and the shots directory is outside the workspace anyway).`;
}
