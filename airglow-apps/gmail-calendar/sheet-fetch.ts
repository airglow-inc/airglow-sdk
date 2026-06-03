import { Composio } from '@composio/core';
import { readFileSync } from 'fs';

for (const l of readFileSync('../.env', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const c = new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
const SID = '1S5FXKb1uW62b7lqL5gjD8MO3UTr_vRCE2szPcd9Qb4E';

const cmd = process.argv[2] || 'info';

async function exec(slug: string, args: any) {
  // wrapped to avoid top-level await
  const r: any = await c.tools.execute(slug, {
    userId: 'default', arguments: args, dangerouslySkipVersionCheck: true,
  });
  return r?.data ?? r;
}

async function main() {
  if (cmd === 'info') {
    const d = await exec('GOOGLESHEETS_GET_SPREADSHEET_INFO', { spreadsheet_id: SID });
    console.log(JSON.stringify((d as any)?.sheets?.map((s: any) => ({
      title: s.properties?.title,
      gid: s.properties?.sheetId,
      rows: s.properties?.gridProperties?.rowCount,
      cols: s.properties?.gridProperties?.columnCount,
    })), null, 2));
  } else if (cmd === 'get') {
    const range = process.argv[3];
    const d = await exec('GOOGLESHEETS_BATCH_GET', { spreadsheet_id: SID, ranges: [range] });
    console.log(JSON.stringify(d, null, 2));
  } else if (cmd === 'update') {
    const range = process.argv[3];
    const valuesJson = process.argv[4];
    const values = JSON.parse(readFileSync(valuesJson, 'utf8'));
    const d = await exec('GOOGLESHEETS_VALUES_UPDATE', {
      spreadsheet_id: SID,
      range,
      values,
      value_input_option: 'RAW',
    });
    console.log(JSON.stringify(d, null, 2));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
