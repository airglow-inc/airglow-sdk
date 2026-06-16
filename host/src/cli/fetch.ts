// `airglow fetch <url>` — fetch a page and print readable content, no browser
// involved. Sends desktop-Chrome headers (many sites serve bots a stub),
// retries with an honest UA on Cloudflare challenges, converts HTML via
// pandoc when installed, falls back to tag-stripping otherwise. Sites with no
// anonymous path (x.com, reddit) fail fast with a pointer to `airglow browser`.

const HELP = `airglow fetch — fetch a URL and print it as readable text

Usage:
  airglow fetch <url> [markdown|text|html]    (default: markdown)
`;

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CHARS = 50_000;
const TIMEOUT_MS = 30_000;
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const UA_HONEST = 'airglow-fetch';

export async function runFetchCli(argv: string[]): Promise<void> {
  let [url, format = 'markdown'] = argv;
  if (!url || url === 'help' || url === '--help') {
    process.stdout.write(HELP);
    process.exit(url ? 0 : 1);
  }
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  // No anonymous path to these — point at the real browser instead
  if (/^https?:\/\/(www\.)?(x|twitter)\.com(\/|$)/i.test(url)) {
    console.error('error: x.com blocks anonymous fetches (login wall); use `airglow browser open` instead');
    process.exit(1);
  }
  if (/^https?:\/\/([a-z]+\.)?reddit\.com(\/|$)/i.test(url)) {
    console.error('error: reddit blocks anonymous fetches (bot wall on HTML and JSON API); use `airglow browser open` instead');
    process.exit(1);
  }

  const fetchOnce = (ua: string) =>
    fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

  let res: Response;
  try {
    res = await fetchOnce(UA_BROWSER);
    // Cloudflare challenges browser UAs whose TLS fingerprint isn't a real
    // browser; an honestly-identified bot UA often passes.
    if (res.status === 403 && res.headers.get('cf-mitigated')?.toLowerCase().includes('challenge')) {
      res = await fetchOnce(UA_HONEST);
    }
  } catch (e: any) {
    console.error(`fetch failed: ${e?.message ?? e}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`error: HTTP ${res.status} for ${url}`);
    process.exit(1);
  }

  let html = '';
  const decoder = new TextDecoder();
  let bytes = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      html += decoder.decode(chunk, { stream: true });
      if (bytes > MAX_BYTES) { console.error(`(truncated at ${MAX_BYTES} bytes)`); break; }
    }
  }

  if (format === 'html') {
    process.stdout.write(cap(html));
    return;
  }
  if (format === 'markdown' && Bun.which('pandoc')) {
    const proc = Bun.spawn(['pandoc', '-f', 'html', '-t', 'markdown', '--wrap=none'], {
      stdin: new Blob([html]),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0) {
      process.stdout.write(cap(out));
      return;
    }
  }
  process.stdout.write(stripHtml(html));
}

function cap(text: string): string {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n…(truncated)' : text;
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  text = text
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => named[e]);
  text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return cap(text);
}

function safeCodePoint(n: number): string {
  try { return String.fromCodePoint(n); } catch { return ''; }
}
