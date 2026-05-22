/**
 * Composio toolkit/tool lookup.
 * Uses Composio REST API directly. Spec: https://backend.composio.dev/api/v3.1/openapi.json
 *
 * Usage:
 *   pnpm composio <toolkit_slug>             — list tools for a toolkit
 *   pnpm composio <toolkit_slug> <tool>      — show full parameter schema
 *   pnpm composio search <query>             — search toolkits by name
 *
 * Examples:
 *   pnpm composio notion
 *   pnpm composio googlesheets GOOGLESHEETS_ADD_SHEET
 *   pnpm composio search google
 *
 * Reads COMPOSIO_API_KEY from the workspace `.env`.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["'](.*)["']$/, "$1");
  }
}

const API_KEY = process.env.COMPOSIO_API_KEY;
if (!API_KEY) {
  console.error("COMPOSIO_API_KEY not set in the workspace .env");
  process.exit(1);
}

const arg1 = process.argv[2];
if (!arg1) {
  console.error(
    "Usage:\n  pnpm composio <toolkit_slug>\n  pnpm composio <toolkit_slug> <TOOL_SLUG>\n  pnpm composio search <query>"
  );
  process.exit(1);
}

const BASE = "https://backend.composio.dev/api/v3.1";
const headers = { "x-api-key": API_KEY! };

async function searchToolkits(query: string) {
  const url = `${BASE}/toolkits?search=${encodeURIComponent(query)}&limit=20`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`API error ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  const items: {
    slug: string;
    name: string;
    meta: { tools_count: number; description: string; categories: { name: string }[] };
  }[] = data.items ?? [];

  if (items.length === 0) {
    console.log(`No toolkits found for "${query}"`);
    return;
  }

  console.log(`Found ${items.length} toolkits for "${query}":\n`);
  for (const tk of items) {
    const cats = tk.meta.categories.map((c) => c.name).join(", ");
    console.log(`${tk.slug} (${tk.meta.tools_count} tools) — ${tk.name}`);
    console.log(`  ${tk.meta.description}`);
    if (cats) console.log(`  categories: ${cats}`);
    console.log();
  }
}

async function listTools(toolkitSlug: string) {
  const url = `${BASE}/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=1000`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`API error ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  const tools: { slug: string; name: string; description: string }[] = data.items ?? [];

  console.log(`${toolkitSlug.toUpperCase()} — ${tools.length} tools\n`);
  for (const t of tools) {
    console.log(`${t.slug}`);
    console.log(`  ${t.name}`);
    console.log(`  ${t.description}\n`);
  }
}

async function showToolSchema(toolkitSlug: string, toolSlug: string) {
  const url = `${BASE}/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&search=${encodeURIComponent(toolSlug)}&limit=10`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`API error ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  const tools: any[] = data.items ?? [];
  const tool = tools.find((t: any) => t.slug === toolSlug);
  if (!tool) {
    console.error(`Tool "${toolSlug}" not found in ${toolkitSlug}. Available: ${tools.map((t: any) => t.slug).join(', ')}`);
    process.exit(1);
  }

  console.log(`${tool.slug}\n  ${tool.name}\n  ${tool.description}\n`);

  const schema = tool.input_parameters || tool.input_schema || tool.inputSchema;
  if (!schema) {
    console.log('(no input schema available)');
    return;
  }

  const props = schema.properties || {};
  const required = new Set(schema.required || []);

  console.log('Parameters:');
  for (const [name, def] of Object.entries(props) as [string, any][]) {
    const req = required.has(name) ? ' (required)' : '';
    const type = def.type || def.anyOf?.map((a: any) => a.type).join('|') || '?';
    const desc = def.description || '';
    const enumVals = def.enum ? ` [${def.enum.join(', ')}]` : '';

    console.log(`  ${name}: ${type}${req}${enumVals}`);
    if (desc) console.log(`    ${desc}`);

    if (def.properties) {
      const nestedReq = new Set(def.required || []);
      for (const [k, v] of Object.entries(def.properties) as [string, any][]) {
        const nr = nestedReq.has(k) ? ' (required)' : '';
        const nt = (v as any).type || '?';
        const ev = (v as any).enum ? ` [${(v as any).enum.join(', ')}]` : '';
        console.log(`    .${k}: ${nt}${nr}${ev}`);
        if ((v as any).description) console.log(`      ${(v as any).description}`);
      }
    }
    console.log();
  }
}

if (arg1 === "search") {
  const query = process.argv[3];
  if (!query) {
    console.error("Usage: pnpm composio search <query>");
    process.exit(1);
  }
  searchToolkits(query);
} else if (process.argv[3]) {
  showToolSchema(arg1, process.argv[3]);
} else {
  listTools(arg1);
}
