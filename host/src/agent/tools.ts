// Agent tools — filesystem (workspace-scoped), bash, and plan. The browser is
// NOT a tool: the agent drives it through the `airglow browser` CLI over
// bash, documented in the system prompt, so any standard coding agent pointed
// at the workspace has the same surface.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { SHOTS_DIR } from '../paths';

const MAX_OUTPUT_CHARS = 50_000;

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n…(truncated, ${text.length - MAX_OUTPUT_CHARS} more chars)`;
}
const DEFAULT_BASH_TIMEOUT_MS = 10_000;
const MAX_ATTACHED_IMAGES = 3;
const MAX_IMAGE_BYTES = 4_000_000;

export interface ToolOutcome {
  content: string;
  isError: boolean;
  // Workspace-relative path written by this call, when it changed app source
  // (drives app-context inference).
  wrotePath?: string;
  // Screenshots referenced in the output, attached to the tool_result as
  // image blocks so the model actually sees them.
  images?: { media_type: string; data: string }[];
}

export const TOOL_DEFINITIONS = [
  {
    name: 'read',
    description: 'Read a file in the workspace. Returns at most 2000 lines starting at `offset` (1-based).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        offset: { type: 'number', description: 'First line to read, 1-based (default 1)' },
        limit: { type: 'number', description: 'Max lines (default 2000)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: 'Create or overwrite a file in the workspace. Creates parent directories.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Replace an exact string in a file. `old_string` must match exactly and (unless replace_all) uniquely.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'List workspace files matching a glob pattern (e.g. "apps/*/manifest.json", "**/*.ts"). node_modules and dotfiles are excluded.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search workspace file contents with a JavaScript regex. Returns file:line matches.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        glob: { type: 'string', description: 'Restrict to files matching this glob' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command. cwd is the workspace root. Use for `bun add/install`, `airglow browser ...`, curl, and other shell work. Output is truncated past 50KB.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short, user-facing phrase (≤6 words, present tense) naming the action this command performs, e.g. "Opening the post composer", "Reading the first feed post". Shown live in the UI so the user can follow along — make it specific to intent, not the command.' },
        command: { type: 'string' },
        timeout_ms: { type: 'number', description: 'Timeout in ms. Default 10000 (10s) — raise it for known-slow commands (installs, builds, large downloads). Max 120000 (2min).' },
      },
      required: ['description', 'command'],
    },
  },
  {
    name: 'task',
    description: 'State, in one short plain-language line, what you are currently doing for the user (e.g. "Blocking all of Instagram behind a focus banner"). It pins at the top of the chat so the user always sees the goal, so this is your FIRST action every turn — call it before you read, search, or edit anything. Don\'t wait until you fully understand the request; a rough title is fine and you can refine it later if the goal sharpens. Set it even for a trivial change or a one-line answer; update it only if the goal materially changes mid-turn.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short objective in plain language, ideally under ~8 words, present tense (e.g. "Adding dark mode to the reader").' },
      },
      required: ['title'],
    },
  },
  {
    name: 'plan',
    description: 'Publish or update your task plan as a checklist shown to the user. Send the full list each time. Use only for genuinely multi-step work; for simple tasks the `task` tool alone is enough.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { text: { type: 'string' }, done: { type: 'boolean' } },
            required: ['text', 'done'],
          },
        },
      },
      required: ['items'],
    },
  },
] as const;

// Server tools — executed by the Anthropic API, not by this process. Sent
// alongside TOOL_DEFINITIONS; results stream back as web_search_tool_result
// blocks inside the assistant message.
export const SERVER_TOOL_DEFINITIONS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
] as const;

export class Tools {
  constructor(
    readonly workspace: string,
    readonly sessionId: string,
    readonly airglowBinDir: string,
    readonly signal?: AbortSignal,
  ) {}

  // Resolve a workspace-relative path, refusing escapes. Hygiene, not a
  // security boundary — bash is unrestricted by design.
  private resolvePath(p: string): string {
    const abs = resolve(this.workspace, p);
    if (abs !== this.workspace && !abs.startsWith(this.workspace + sep)) {
      throw new Error(`path escapes the workspace: ${p}`);
    }
    return abs;
  }

  async execute(name: string, input: any): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'read': return this.read(input);
        case 'write': return this.write(input);
        case 'edit': return this.edit(input);
        case 'glob': return this.glob(input);
        case 'grep': return this.grep(input);
        case 'bash': return await this.bash(input);
        case 'task': return { content: 'Task noted.', isError: false };
        case 'plan': return { content: 'Plan updated.', isError: false };
        default: return { content: `unknown tool: ${name}`, isError: true };
      }
    } catch (e: any) {
      return { content: String(e?.message ?? e), isError: true };
    }
  }

  private read(input: { path: string; offset?: number; limit?: number }): ToolOutcome {
    const abs = this.resolvePath(input.path);
    if (!existsSync(abs)) return { content: `file not found: ${input.path}`, isError: true };
    if (statSync(abs).isDirectory()) {
      const entries = readdirSync(abs).filter((n) => n !== 'node_modules' && !n.startsWith('.'));
      return { content: `(directory) entries:\n${entries.join('\n')}`, isError: false };
    }
    const lines = readFileSync(abs, 'utf8').split('\n');
    const offset = Math.max(1, input.offset ?? 1);
    const limit = Math.min(input.limit ?? 2000, 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let out = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
    out = truncateOutput(out);
    if (offset - 1 + limit < lines.length) out += `\n…(${lines.length - (offset - 1 + limit)} more lines)`;
    return { content: out || '(empty file)', isError: false };
  }

  private write(input: { path: string; content: string }): ToolOutcome {
    const abs = this.resolvePath(input.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, input.content);
    return { content: `wrote ${input.path} (${input.content.length} chars)`, isError: false, wrotePath: relative(this.workspace, abs) };
  }

  private edit(input: { path: string; old_string: string; new_string: string; replace_all?: boolean }): ToolOutcome {
    const abs = this.resolvePath(input.path);
    if (!existsSync(abs)) return { content: `file not found: ${input.path}`, isError: true };
    const text = readFileSync(abs, 'utf8');
    const count = text.split(input.old_string).length - 1;
    if (count === 0) return { content: 'old_string not found in file', isError: true };
    if (count > 1 && !input.replace_all) {
      return { content: `old_string matches ${count} times — make it unique or set replace_all`, isError: true };
    }
    const next = input.replace_all
      ? text.split(input.old_string).join(input.new_string)
      : text.replace(input.old_string, input.new_string);
    writeFileSync(abs, next);
    return { content: `edited ${input.path} (${count} replacement${count > 1 ? 's' : ''})`, isError: false, wrotePath: relative(this.workspace, abs) };
  }

  private glob(input: { pattern: string }): ToolOutcome {
    const glob = new Bun.Glob(input.pattern);
    const results: string[] = [];
    for (const p of glob.scanSync({ cwd: this.workspace, dot: false })) {
      if (p.includes('node_modules/') || p.startsWith('.')) continue;
      results.push(p);
      if (results.length >= 500) { results.push('…(capped at 500)'); break; }
    }
    return { content: results.join('\n') || '(no matches)', isError: false };
  }

  private grep(input: { pattern: string; glob?: string; ignore_case?: boolean }): ToolOutcome {
    const re = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
    const fileGlob = new Bun.Glob(input.glob || '**/*');
    const results: string[] = [];
    outer: for (const p of fileGlob.scanSync({ cwd: this.workspace, dot: false })) {
      if (p.includes('node_modules/') || p.startsWith('.')) continue;
      const abs = join(this.workspace, p);
      let text: string;
      try {
        const stat = statSync(abs);
        if (!stat.isFile() || stat.size > 2_000_000) continue;
        text = readFileSync(abs, 'utf8');
      } catch { continue; }
      if (text.includes(' ')) continue; // binary
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${p}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (results.length >= 200) { results.push('…(capped at 200)'); break outer; }
        }
      }
    }
    return { content: results.join('\n') || '(no matches)', isError: false };
  }

  private async bash(input: { command: string; timeout_ms?: number }): Promise<ToolOutcome> {
    const timeout = Math.min(input.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS, 120_000);
    const proc = Bun.spawn(['/bin/bash', '-lc', input.command], {
      cwd: this.workspace,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        AIRGLOW_SESSION: this.sessionId,
        // Make `airglow` resolve to this host binary/shim inside agent shells.
        PATH: `${this.airglowBinDir}:${process.env.PATH ?? ''}`,
      },
    });
    const killTimer = setTimeout(() => proc.kill(), timeout);
    const onAbort = () => proc.kill();
    this.signal?.addEventListener('abort', onAbort, { once: true });

    // Read incrementally instead of awaiting full-stream collection: when the
    // shell is killed, orphaned children may keep the pipes open (e.g. a
    // backgrounded or long-running child inherits stdout), and a plain
    // Response(stream).text() would block until THEY exit. After the process
    // exits we give the pipes a short grace period and return what we have.
    let stdout = '';
    let stderr = '';
    const decoder = new TextDecoder();
    const drain = async (stream: ReadableStream<Uint8Array>, append: (s: string) => void) => {
      try {
        for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
      } catch {}
    };
    const drains = Promise.all([
      drain(proc.stdout, (s) => { stdout += s; }),
      drain(proc.stderr, (s) => { stderr += s; }),
    ]);
    const exitCode = await proc.exited;
    await Promise.race([drains, Bun.sleep(300)]);

    clearTimeout(killTimer);
    this.signal?.removeEventListener('abort', onAbort);
    let out = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
    out = truncateOutput(out).trim() || '(no output)';
    return {
      content: exitCode === 0 ? out : `exit code ${exitCode}\n${out}`,
      isError: exitCode !== 0,
      images: collectShotImages(out),
    };
  }
}

// Find screenshot paths (from `airglow browser shot`) in command output and
// load them so they ride along in the tool_result.
function collectShotImages(out: string): ToolOutcome['images'] {
  const images: NonNullable<ToolOutcome['images']> = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s"'`])(\S*\/shots\/[A-Za-z0-9_.-]+\.(jpe?g|png|webp))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) && images.length < MAX_ATTACHED_IMAGES) {
    const file = join(SHOTS_DIR, m[1].split('/').pop()!);
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      if (!existsSync(file) || statSync(file).size > MAX_IMAGE_BYTES) continue;
      const ext = m[2].toLowerCase();
      images.push({
        media_type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
        data: readFileSync(file).toString('base64'),
      });
    } catch {}
  }
  return images.length ? images : undefined;
}
