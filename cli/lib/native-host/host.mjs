#!/usr/bin/env node
// Airglow extension debug bridge — Chrome native messaging host.
//
// Chrome spawns this process when the extension calls
// chrome.runtime.connectNative('com.airglow.spy'). The process opens an HTTP
// server on localhost:3101 so anything outside Chrome (curl, the agent) can
// talk to the running extension.
//
// Primary endpoints (always available):
//   GET  /logs        — extension log ring buffer (filterable by level, source)
//   POST /reload      — chrome.runtime.reload() the extension
//   GET  /status      — liveness + buffered-capture count
//
// Network-spy endpoints (dormant — only useful when reverse-engineering a
// website's API; require an explicit POST /attach to activate, otherwise
// zero overhead):
//   POST /attach      — start CDP + fetch/XHR interception on a tab
//   POST /detach      — stop capture
//   GET  /read        — list captured requests (filters + compact mode)
//   GET  /entry?i=N   — full request/response for one captured entry
//   GET  /storage     — read localStorage/sessionStorage from the attached page
//
// See README.md in this directory for the full endpoint reference.
//
// Native messaging protocol: 4-byte LE length header + UTF-8 JSON payload,
// both directions, over stdio between Chrome and this process.

import http from 'node:http';

const HTTP_PORT = 3101;
const CDP_PORT = 9222;
const CAPTURE_BUFFER_LIMIT = 2000;
const BODY_TRUNCATE = 20000; // max chars stored per body field

// ───── CDP network capture ─────
const cdpSessions = new Map(); // tabId → { sockets }

async function cdpAttach(tabId, tabUrl) {
  if (cdpSessions.has(tabId)) return;
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await res.json();

  let pageOrigin = tabUrl ? new URL(tabUrl).origin : null;
  const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl &&
    (pageOrigin ? t.url.startsWith(pageOrigin) : true));
  if (!pageTarget) { log('cdp: no page target found'); return; }
  pageOrigin = pageOrigin || new URL(pageTarget.url).origin;

  // Page + all workers (origin-matched + blank-URL workers)
  const cdpTargets = [pageTarget,
    ...targets.filter(t => t.type === 'worker' && t.webSocketDebuggerUrl &&
      (t.url.includes(pageOrigin) || !t.url))];

  log(`cdp: attaching to ${cdpTargets.length} targets (1 page + ${cdpTargets.length - 1} workers)`);
  const sockets = [];

  for (const target of cdpTargets) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let cdpId = 1;
    const send = (method, params = {}) => ws.send(JSON.stringify({ id: cdpId++, method, params }));
    const pending = new Map(); // network requestId → partial entry
    const bodyReqs = new Map(); // cdp msg id → network requestId

    ws.addEventListener('open', () => {
      send('Network.enable');
      log(`cdp: Network.enable on ${target.type} ${target.url?.substring(0, 50) || '(blank)'}`);
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(typeof evt.data === 'string' ? evt.data : evt.data.toString()); } catch { return; }

      if (msg.method === 'Network.requestWillBeSent') {
        const r = msg.params.request;
        pending.set(msg.params.requestId, {
          url: r.url, method: r.method,
          reqHeaders: r.headers || {},
          reqBody: r.postData?.slice(0, BODY_TRUNCATE) || null,
          ts: Date.now(), transport: 'cdp', tabId,
        });
      } else if (msg.method === 'Network.responseReceived') {
        const entry = pending.get(msg.params.requestId);
        if (entry) {
          entry.status = msg.params.response.status;
          entry.resHeaders = msg.params.response.headers || {};
        }
      } else if (msg.method === 'Network.loadingFinished') {
        const entry = pending.get(msg.params.requestId);
        if (entry) {
          bodyReqs.set(cdpId, msg.params.requestId);
          send('Network.getResponseBody', { requestId: msg.params.requestId });
        }
      } else if (msg.method === 'Network.loadingFailed') {
        pending.delete(msg.params.requestId);
      } else if (msg.id && bodyReqs.has(msg.id)) {
        const netId = bodyReqs.get(msg.id);
        bodyReqs.delete(msg.id);
        const entry = pending.get(netId);
        pending.delete(netId);
        if (entry) {
          entry.resBody = (msg.result?.body || '').slice(0, BODY_TRUNCATE);
          pushCapture(entry);
        }
      }
    });

    ws.addEventListener('error', () => {});
    ws.addEventListener('close', () => {});
    sockets.push(ws);
  }

  cdpSessions.set(tabId, { sockets });
}

function cdpDetach(tabId) {
  const s = cdpSessions.get(tabId);
  if (s) { for (const ws of s.sockets) { try { ws.close(); } catch {} } cdpSessions.delete(tabId); }
}

// ───── Native messaging framing ─────
function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([len, json]));
}

let stdinBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + len) break;
    const payload = stdinBuf.subarray(4, 4 + len).toString('utf8');
    stdinBuf = stdinBuf.subarray(4 + len);
    try { onExtensionMessage(JSON.parse(payload)); } catch (e) { log('parse error: ' + e.message); }
  }
});
process.stdin.on('end', () => process.exit(0));

// ───── State ─────
const captures = [];
let lastReadResult = null;
const pendingReplies = new Map();
let nextReqId = 1;
// Track seen CDP request URLs+timestamps to deduplicate fetch interceptor entries
const recentCdpUrls = new Map(); // url+method → timestamp (last 5s)

function pushCapture(entry) {
  // Dedup: if CDP already captured this request, skip fetch duplicate
  if (entry.transport === 'cdp') {
    recentCdpUrls.set(entry.method + ' ' + entry.url, entry.ts);
  } else if (entry.transport === 'fetch' || entry.transport === 'xhr') {
    const key = entry.method + ' ' + entry.url;
    const cdpTs = recentCdpUrls.get(key);
    if (cdpTs && Math.abs(entry.ts - cdpTs) < 5000) return; // skip duplicate
  }
  captures.push(entry);
  if (captures.length > CAPTURE_BUFFER_LIMIT) captures.splice(0, captures.length - CAPTURE_BUFFER_LIMIT);
  // Trim dedup map
  if (recentCdpUrls.size > 500) {
    const cutoff = Date.now() - 10000;
    for (const [k, v] of recentCdpUrls) { if (v < cutoff) recentCdpUrls.delete(k); }
  }
}

function onExtensionMessage(msg) {
  if (msg.type === 'capture' && msg.entry) {
    pushCapture(msg.entry);
  } else if (msg.type === 'reply' && msg.reqId) {
    const p = pendingReplies.get(msg.reqId);
    if (p) { clearTimeout(p.timer); pendingReplies.delete(msg.reqId); p.resolve(msg.payload); }
  } else if (msg.type === 'log') {
    log('[ext] ' + msg.message);
  }
}

function sendToExtension(payload, { expectReply = false, timeoutMs = 3000 } = {}) {
  if (!expectReply) { writeMessage(payload); return Promise.resolve(null); }
  const reqId = String(nextReqId++);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingReplies.delete(reqId); resolve({ error: 'timeout' }); }, timeoutMs);
    pendingReplies.set(reqId, { resolve, timer });
    writeMessage({ ...payload, reqId });
  });
}

// ───── Noise filter ─────
// Generic patterns — static assets and common telemetry. Site-specific noise can be
// added via ?ignore=pattern1,pattern2 on /read.
const NOISE_PATTERNS = [
  'browser.pipe.aria.microsoft.com', 'browser.events.data.microsoft.com',
  '/OneCollector/', '/Collector/3.0',
];

function isStaticAsset(url) {
  return /\.(js|css|svg|png|jpg|gif|woff2?|ico|map)(\?|$)/.test(url.split('?')[0]);
}

function isNoise(entry, extraPatterns) {
  const url = entry.url || '';
  if (isStaticAsset(url)) return true;
  if (NOISE_PATTERNS.some((p) => url.includes(p))) return true;
  if (extraPatterns?.length && extraPatterns.some((p) => url.includes(p))) return true;
  return false;
}

// ───── HTTP API ─────
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Build a curl command string from a captured entry (for replay)
function buildCurl(entry) {
  let cmd = `curl -s -X ${entry.method} '${entry.url}'`;
  const headers = entry.reqHeaders || {};
  for (const [k, v] of Object.entries(headers)) {
    // Skip pseudo-headers and very long values
    if (k.startsWith(':')) continue;
    cmd += ` \\\n  -H '${k}: ${v.length > 200 ? v.substring(0, 200) + '...' : v}'`;
  }
  if (entry.reqBody) {
    // Reference saved file instead of inlining huge bodies
    cmd += ` \\\n  -d '<request body, ${entry.reqBody.length} chars>'`;
  }
  return cmd;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    // POST /attach — start capturing on a tab
    if (req.method === 'POST' && url.pathname === '/attach') {
      const body = JSON.parse(await readBody(req));
      const tabId = body.tabId;
      const tabUrl = body.url;
      const reply = await sendToExtension({ type: 'attach', tabId }, { expectReply: true });
      try { await cdpAttach(tabId, tabUrl); } catch (e) { log('cdp attach failed: ' + e.message); }
      return json(res, 200, { ok: true, tabId, reply });
    }

    // POST /detach — stop capturing
    if (req.method === 'POST' && url.pathname === '/detach') {
      const { tabId } = JSON.parse(await readBody(req));
      const reply = await sendToExtension({ type: 'detach', tabId }, { expectReply: true });
      cdpDetach(tabId);
      return json(res, 200, { ok: true, tabId, reply });
    }

    // GET /read — list captured requests
    //   compact=1     → summary view: index, method, url, status, body lengths, 200-char response preview
    //   url=substr     → filter by URL substring
    //   method=POST    → filter by HTTP method
    //   noise=1        → include static assets and telemetry (excluded by default)
    //   ignore=a,b     → extra URL substrings to filter out
    //   clear=1        → clear buffer after reading
    //   since=ts       → only entries after this timestamp
    if (req.method === 'GET' && url.pathname === '/read') {
      const tabId = url.searchParams.get('tabId');
      const since = Number(url.searchParams.get('since') || 0);
      const clear = url.searchParams.get('clear') === '1';
      const compact = url.searchParams.get('compact') === '1';
      const urlFilter = url.searchParams.get('url');
      const methodFilter = url.searchParams.get('method')?.toUpperCase();
      const noNoise = url.searchParams.get('noise') !== '1';
      const extraIgnore = url.searchParams.get('ignore')?.split(',').filter(Boolean) || [];

      let filtered = captures.filter((e) => (tabId ? String(e.tabId) === tabId : true) && e.ts > since);
      if (noNoise) filtered = filtered.filter((e) => !isNoise(e, extraIgnore));
      if (urlFilter) filtered = filtered.filter((e) => e.url?.includes(urlFilter));
      if (methodFilter) filtered = filtered.filter((e) => e.method === methodFilter);

      lastReadResult = filtered;

      let entries;
      if (compact) {
        entries = filtered.map((e, i) => ({
          i, method: e.method, status: e.status, transport: e.transport,
          url: e.url,
          reqLen: e.reqBody?.length || 0,
          resLen: e.resBody?.length || 0,
          resPreview: e.resBody ? e.resBody.slice(0, 200) : null,
        }));
      } else {
        entries = filtered;
      }

      if (clear) {
        for (let i = captures.length - 1; i >= 0; i--) {
          if (tabId ? String(captures[i].tabId) === tabId : true) captures.splice(i, 1);
        }
      }
      return json(res, 200, { entries, count: entries.length });
    }

    // GET /entry?i=N — full entry from last /read result, including headers for replay
    //   curl=1  → include a ready-to-use curl command
    //   body=req|res|both  → which bodies to include (default: both)
    if (req.method === 'GET' && url.pathname === '/entry') {
      const idx = Number(url.searchParams.get('i'));
      if (!lastReadResult || idx < 0 || idx >= lastReadResult.length) {
        return json(res, 404, { error: 'index out of range, run /read first', total: lastReadResult?.length || 0 });
      }
      const entry = lastReadResult[idx];
      const includeCurl = url.searchParams.get('curl') === '1';
      const bodyFilter = url.searchParams.get('body') || 'both';
      const result = { ...entry };
      if (bodyFilter === 'req') delete result.resBody;
      else if (bodyFilter === 'res') delete result.reqBody;
      if (includeCurl) result.curl = buildCurl(entry);
      return json(res, 200, result);
    }

    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, { ok: true, service: 'airglow-spy', buffered: captures.length });
    }

    // POST /reload — reload extension
    if (req.method === 'POST' && url.pathname === '/reload') {
      sendToExtension({ type: 'reload' });
      return json(res, 200, { ok: true, reloading: true });
    }

    // GET /logs — extension log store
    if (req.method === 'GET' && url.pathname === '/logs') {
      const level = url.searchParams.get('level');
      const source = url.searchParams.get('source');
      const n = Number(url.searchParams.get('n') || 50);
      const reply = await sendToExtension({ type: 'logs' }, { expectReply: true, timeoutMs: 5000 });
      if (reply?.error) return json(res, 500, { error: reply.error });
      let entries = reply?.entries || [];
      if (level) entries = entries.filter((e) => e.level === level);
      if (source) entries = entries.filter((e) => e.source === source);
      entries = entries.slice(-n);
      return json(res, 200, { entries, count: entries.length });
    }

    // GET /storage — read localStorage/sessionStorage from the attached page
    //   pattern=token   → filter keys by regex pattern (case-insensitive)
    //   store=local|session|both  → which storage to read (default: both)
    if (req.method === 'GET' && url.pathname === '/storage') {
      const pattern = url.searchParams.get('pattern') || '';
      const store = url.searchParams.get('store') || 'both';
      const full = url.searchParams.get('full') === '1';

      // Find the page target for any attached tab
      const tabId = cdpSessions.keys().next().value;
      if (!tabId) return json(res, 400, { error: 'No tab attached. POST /attach first.' });

      try {
        const cdpRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
        const targets = await cdpRes.json();
        const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl &&
          cdpSessions.has(tabId) && t.url?.startsWith('http'));
        if (!page) return json(res, 400, { error: 'No page target found' });

        const ws = new WebSocket(page.webSocketDebuggerUrl);
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
          ws.addEventListener('open', () => {
            const expr = `(function(){
              var results = [];
              var full = ${JSON.stringify(full)};
              var pat = ${JSON.stringify(pattern)};
              var re = pat ? new RegExp(pat, 'i') : null;
              function scan(storage, name) {
                try {
                  for (var i = 0; i < storage.length; i++) {
                    var k = storage.key(i);
                    if (re && !re.test(k)) continue;
                    var v = storage.getItem(k);
                    var truncated = v?.length > 2000 && !full;
                    results.push({ store: name, key: k, value: truncated ? v.substring(0, 2000) : v, length: v?.length || 0, truncated: !!truncated });
                  }
                } catch(e) {}
              }
              if (${JSON.stringify(store)} !== 'session') scan(localStorage, 'local');
              if (${JSON.stringify(store)} !== 'local') scan(sessionStorage, 'session');
              return JSON.stringify(results);
            })()`;
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
          });
          ws.addEventListener('message', (evt) => {
            const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : evt.data.toString());
            if (msg.id === 1) {
              clearTimeout(timer);
              ws.close();
              try { resolve(JSON.parse(msg.result?.result?.value || '[]')); }
              catch { resolve([]); }
            }
          });
          ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
        });

        const anyTruncated = result.some(e => e.truncated);
        const resp = { entries: result, count: result.length };
        if (anyTruncated) resp.hint = 'Some values were truncated. Use full=1 to get complete values.';
        return json(res, 200, resp);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

server.on('error', (e) => { log('http server error: ' + e.message); });
server.listen(HTTP_PORT, '127.0.0.1', () => {
  log(`http listening on 127.0.0.1:${HTTP_PORT}`);
  writeMessage({ type: 'ready', httpPort: HTTP_PORT });
});

function log(msg) {
  process.stderr.write(`[airglow-spy] ${msg}\n`);
}
