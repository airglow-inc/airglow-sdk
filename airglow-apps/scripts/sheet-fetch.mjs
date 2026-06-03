import { Composio } from '@composio/core';
const c = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const SID = '1S5FXKb1uW62b7lqL5gjD8MO3UTr_vRCE2szPcd9Qb4E';
const r = await c.tools.execute('GOOGLESHEETS_GET_SPREADSHEET_INFO', {
  userId: 'default',
  arguments: { spreadsheet_id: SID },
  dangerouslySkipVersionCheck: true,
});
const data = r?.data || r;
console.log(JSON.stringify(data?.sheets?.map(s => ({title: s.properties?.title, gid: s.properties?.sheetId, rows: s.properties?.gridProperties?.rowCount, cols: s.properties?.gridProperties?.columnCount})), null, 2));
