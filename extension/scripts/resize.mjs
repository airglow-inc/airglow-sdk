const browserWs = process.argv[2];
const targetId = process.argv[3];
const W = parseInt(process.argv[4] || '1600');
const H = parseInt(process.argv[5] || '900');

const ws = new WebSocket(browserWs);
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  }
});
ws.addEventListener('open', async () => {
  try {
    const { windowId } = await send('Browser.getWindowForTarget', { targetId });
    console.log('windowId:', windowId);
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    const r = await send('Browser.setWindowBounds', { windowId, bounds: { width: W, height: H, left: 100, top: 80 } });
    console.log('set:', JSON.stringify(r));
  } catch (e) { console.error(e); }
  ws.close();
});
