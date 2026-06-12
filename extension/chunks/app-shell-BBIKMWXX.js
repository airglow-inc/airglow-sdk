import"./_virtual_wxt-html-plugins-GZrWlJ2F.js";import{u as e}from"./airglow-identity-BV1iexHI.js";var t=`__airglow_logs`,n=1e3;function r(e){let t={info:0,warn:0,error:0};for(let n of e)t[n.level]++;let r={info:Math.max(0,t.info-n),warn:Math.max(0,t.warn-n),error:Math.max(0,t.error-n)};if(r.info===0&&r.warn===0&&r.error===0)return e;let i={...r},a=[];for(let t of e){if(i[t.level]>0){i[t.level]--;continue}a.push(t)}return a}var i=[],a=null,o=300;function s(){a||=setTimeout(c,o)}async function c(){if(a=null,i.length===0)return;let e=i;i=[];try{let n=await chrome.storage.local.get(t),i=r((Array.isArray(n[t])?n[t]:[]).concat(e));await chrome.storage.local.set({[t]:i})}catch{i=e.concat(i)}}function l(e,t,n,r){let a={ts:Date.now(),level:e,source:t,message:n};r&&(a.stack=r),i.push(a),s();let o=`[${t}]`;e===`error`?console.error(o,n,r||``):e===`warn`?console.warn(o,n):console.log(o,n)}var u={info:(e,t)=>l(`info`,e,t),warn:(e,t)=>l(`warn`,e,t),error:(e,t,n)=>l(`error`,e,t,n),async getAll(){let e=await chrome.storage.local.get(t);return Array.isArray(e[t])?e[t]:[]},async clear(){i=[],await chrome.storage.local.remove(t)}},d=`0.1.0-beta.1`;function f(e){return`
(function() {
  const APP_ID = ${JSON.stringify(e)};
  const SDK_VERSION = ${JSON.stringify(d)};
  const usePostMessage = typeof chrome === 'undefined' || !chrome.runtime?.sendMessage;

  let callCounter = 0;
  const pendingCalls = {};

  function makeAirglowError(response) {
    const error = new Error(response?.error || 'Airglow SDK call failed');
    error.name = 'AirglowError';
    if (response?.code) error.code = response.code;
    if (response?.status) error.status = response.status;
    if (response?.requestId) error.requestId = response.requestId;
    if (response?.details !== undefined) error.details = response.details;
    if (response?.onboardingUrl) error.onboardingUrl = response.onboardingUrl;
    return error;
  }

  function runtimeErrorPayload(kind, error, extras) {
    const message = error?.message || String(error || kind);
    return {
      kind,
      message,
      name: error?.name,
      stack: error?.stack,
      ...extras,
    };
  }

  function notifyRuntimeError(payload) {
    if (usePostMessage && globalThis.parent && globalThis.parent !== globalThis) {
      globalThis.parent.postMessage({
        _airglow_app_error: true,
        appId: APP_ID,
        sdkVersion: SDK_VERSION,
        ...payload,
      }, '*');
    }
  }

  function logRuntimeError(payload) {
    sendMsg({
      type: 'airglow:log',
      level: 'error',
      message: payload.message || 'Unhandled app error',
      stack: payload.stack,
      data: {
        kind: payload.kind,
        name: payload.name,
        filename: payload.filename,
        lineno: payload.lineno,
        colno: payload.colno,
      },
    }).catch(function() {});
  }

  // Listen for postMessage responses from parent (app-shell)
  if (usePostMessage) {
    window.addEventListener('message', function(e) {
      if (e.data?._airglow_response && e.data._callId != null) {
        const cb = pendingCalls[e.data._callId];
        if (cb) {
          delete pendingCalls[e.data._callId];
          cb(e.data);
        }
      }
    });
  }

  function sendMsg(payload) {
    if (usePostMessage) {
      return new Promise((resolve, reject) => {
        const callId = callCounter++;
        pendingCalls[callId] = (response) => {
          if (response?.error) reject(makeAirglowError(response));
          else resolve(response);
        };
        window.parent.postMessage(
          { ...payload, _airglow: true, _appId: APP_ID, _callId: callId },
          '*'
        );
      });
    }
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { ...payload, _airglow: true, _appId: APP_ID },
        async (response) => {
          if (chrome.runtime.lastError) {
            reject(makeAirglowError({
              error: chrome.runtime.lastError.message,
              code: 'CHROME_RUNTIME_ERROR',
            }));
          } else if (response?.error) {
            reject(makeAirglowError(response));
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  const storage = {
    async get(key) {
      const res = await sendMsg({ type: 'airglow:storage:get', key });
      return res?.value;
    },
    async set(key, value) {
      await sendMsg({ type: 'airglow:storage:set', key, value });
    },
    async delete(key) {
      await sendMsg({ type: 'airglow:storage:delete', key });
    },
    async list() {
      const res = await sendMsg({ type: 'airglow:storage:list' });
      return res?.keys ?? [];
    },
  };

  const log = {
    async info(message, data) {
      await sendMsg({ type: 'airglow:log', level: 'info', message, data });
    },
    async warn(message, data) {
      await sendMsg({ type: 'airglow:log', level: 'warn', message, data });
    },
    async error(message, data) {
      await sendMsg({ type: 'airglow:log', level: 'error', message, data });
    },
  };

  // Auto-capture uncaught errors. The global error handler also fires for
  // errors from the host page (e.g. Outlook's own ResizeObserver loop), so we
  // only report errors whose filename or stack points back to our bundle —
  // app-loader prepends a "//# sourceURL=airglow-app://..." directive that
  // tags every frame of our injected code.
  function isAppError(filename, stack) {
    if (typeof filename === 'string' && filename.indexOf('airglow-app://') === 0) return true;
    if (typeof stack === 'string' && stack.indexOf('airglow-app://') !== -1) return true;
    return false;
  }
  window.addEventListener('error', function(e) {
    if (!isAppError(e.filename, e.error?.stack)) return;
    const payload = runtimeErrorPayload('uncaught_error', e.error || e.message, {
      message: e.message || e.error?.message || 'Uncaught error',
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
    });
    notifyRuntimeError(payload);
    logRuntimeError(payload);
  });
  window.addEventListener('unhandledrejection', function(e) {
    const reason = e.reason;
    if (!isAppError(reason?.fileName, reason?.stack)) return;
    const payload = runtimeErrorPayload('unhandled_rejection', reason, {
      message: reason?.message || 'Unhandled promise rejection',
    });
    notifyRuntimeError(payload);
    logRuntimeError(payload);
  });

  async function airglowFetch(url, opts = {}) {
    const { includeCookies, ...fetchOpts } = opts;
    const res = await sendMsg({
      type: 'airglow:fetch',
      url,
      method: fetchOpts.method || 'GET',
      headers: fetchOpts.headers,
      body: fetchOpts.body,
      includeCookies: !!includeCookies,
    });
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      json: () => Promise.resolve(res.body),
      text: () => Promise.resolve(typeof res.body === 'string' ? res.body : JSON.stringify(res.body)),
    };
  }

  async function rpc(functionName, payload) {
    const res = await sendMsg({ type: 'airglow:rpc', functionName, payload });
    return res?.result;
  }

  const platform = {
    async registerRedirects(rules) {
      await sendMsg({ type: 'airglow:platform:registerRedirects', rules });
    },
    async allowIframes(domains, initiators) {
      await sendMsg({ type: 'airglow:platform:allowIframes', domains, initiators: initiators || [] });
    },
  };

  const identity = {
    async launchWebAuthFlow(url) {
      const res = await sendMsg({ type: 'airglow:identity:launchWebAuthFlow', url });
      return res?.redirectUrl;
    },
    async getRedirectURL() {
      const res = await sendMsg({ type: 'airglow:identity:getRedirectURL' });
      return res?.url;
    },
    async getUserEmail() {
      const res = await sendMsg({ type: 'airglow:identity:getUserEmail' });
      return res?.email;
    },
    async setUserEmail(email) {
      const res = await sendMsg({ type: 'airglow:identity:setUserEmail', email });
      return res?.email;
    },
  };

  const llm = {
    anthropic: {
      async messages(payload) {
        const res = await sendMsg({ type: 'airglow:llm:anthropic:messages', payload });
        return res?.result;
      },
    },
  };

  const page = {
    async replaceEditorText(text, opts = {}) {
      const res = await sendMsg({
        type: 'airglow:page:replaceEditorText',
        text: String(text ?? ''),
        selectors: Array.isArray(opts.selectors) ? opts.selectors : undefined,
      });
      return res?.result;
    },
  };

  async function captureTab() {
    const res = await sendMsg({ type: 'airglow:captureTab' });
    if (res?.error) throw new Error(res.error);
    return { base64: res.base64, mediaType: res.mediaType };
  }

  async function openWindow(url, opts = {}) {
    await sendMsg({ type: 'airglow:openWindow', url, width: opts.width, height: opts.height, left: opts.left, top: opts.top, popup: opts.popup });
  }

  async function openWindowAndWaitClose(url, opts = {}) {
    await sendMsg({ type: 'airglow:openWindow', url, width: opts.width, height: opts.height, left: opts.left, top: opts.top, popup: opts.popup, waitClose: true });
  }

  async function openTab(url, opts = {}) {
    await sendMsg({ type: 'airglow:openTab', url, active: opts.active });
  }

  globalThis.airglow = {
    sdkVersion: SDK_VERSION,
    fetch: airglowFetch,
    storage,
    log,
    rpc,
    llm,
    page,
    platform,
    identity,
    captureTab,
    openWindow,
    openWindowAndWaitClose,
    openTab,
  };
})();
`}var p=`__app_sources`,m=`__app_manifests`,h=`__dev_server_online`,g=12e3,_=8e3,v=[1e3,3e3],y=[500,1500],b=`_airglowRuntimeUserApproved`,x=new URLSearchParams(window.location.search),S=x.get(`app`);C();async function C(){if(!S){document.getElementById(`loading`).textContent=`Missing app parameter`;return}try{await e({requireSession:!0})}catch{w();return}E(S)}function w(){let e=document.getElementById(`root`),t=document.getElementById(`loading`);if(t&&t.remove(),!e)return;e.textContent=``;let n=document.createElement(`div`);n.id=`airglow-app-auth-required`,n.style.cssText=[`position:fixed`,`inset:0`,`display:flex`,`align-items:center`,`justify-content:center`,`padding:24px`,`background:#f5f5f4`,`color:#1c1917`].join(`;`);let r=document.createElement(`div`);r.style.cssText=[`width:min(520px,100%)`,`border:1px solid #e7e5e4`,`border-radius:8px`,`background:#fff`,`padding:24px`,`box-shadow:0 12px 32px rgba(28,25,23,.10)`].join(`;`);let i=document.createElement(`div`);i.textContent=`Airglow account required`,i.style.cssText=`font-size:13px;color:#78716c;margin-bottom:6px`;let a=document.createElement(`div`);a.textContent=`Sign in to open this app`,a.style.cssText=`font-size:22px;font-weight:700;line-height:1.2;margin-bottom:8px;color:#1c1917`;let o=document.createElement(`p`);o.textContent=`Airglow apps, page injection, and cloud generation are unavailable until this browser is signed in.`,o.style.cssText=`font-size:14px;line-height:1.5;color:#57534e;margin:0 0 18px`;let s=document.createElement(`div`);s.style.cssText=`display:flex;gap:8px;align-items:center;flex-wrap:wrap`;let c=document.createElement(`button`);c.type=`button`,c.textContent=`Open dashboard`,c.style.cssText=`height:38px;padding:0 14px;border:0;border-radius:8px;background:#1c1917;color:#fff;font-size:14px;font-weight:650;cursor:pointer`,c.addEventListener(`click`,()=>{window.location.href=chrome.runtime.getURL(`dashboard.html`)});let l=document.createElement(`button`);l.type=`button`,l.textContent=`Retry`,l.style.cssText=`height:38px;padding:0 14px;border:1px solid #d6d3d1;border-radius:8px;background:#fff;color:#44403c;font-size:14px;font-weight:650;cursor:pointer`,l.addEventListener(`click`,()=>location.reload()),s.append(c,l),r.append(i,a,o,s),n.append(r),e.append(n);let u=e=>{(`__airglow_session_token`in e||`__airglow_refresh_token`in e||`__airglow_auth_provider`in e)&&(chrome.storage.local.onChanged.removeListener(u),location.reload())};chrome.storage.local.onChanged.addListener(u)}function T(e){document.body.innerHTML=``;let t=`#b91c1c`,n=`#1c1917`,r=document.createElement(`div`);r.id=`airglow-app-offline`,r.style.cssText=`position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:#f5f5f4;color:${n};`,r.innerHTML=`
    <div style="text-align:center;max-width:560px;padding:36px;border-radius:12px;border:1px solid color-mix(in srgb, #b91c1c 30%, #e7e5e4);background:color-mix(in srgb, #b91c1c 8%, #ffffff)">
      <div style="display:flex;justify-content:center;margin-bottom:18px">
        <div style="display:inline-flex;padding:18px;border-radius:9999px;background:color-mix(in srgb, #b91c1c 18%, #ffffff);color:${t}">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        </div>
      </div>
      <div style="font-size:28px;font-weight:700;line-height:1.2;margin-bottom:12px;color:${n}">Dev server is offline</div>
      <p style="font-size:18px;line-height:1.55;color:#57534e;margin:0">
        Run <code style="background:#fafaf9;padding:2px 8px;border-radius:4px;color:${n};font-size:17px">pnpm airglow dev</code>
        to start the dev server and load this app.
      </p>
      <button id="airglow-offline-retry" type="button" style="margin-top:24px;height:44px;padding:0 22px;border:1px solid ${t};color:${t};background:transparent;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:10px">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg><span>Retry</span>
      </button>
    </div>
  `,document.body.appendChild(r),document.getElementById(`airglow-offline-retry`)?.addEventListener(`click`,()=>location.reload());let i=e=>{h in e&&e[h].newValue===!0&&(chrome.storage.local.onChanged.removeListener(i),location.reload())};chrome.storage.local.onChanged.addListener(i)}async function E(e){let t=await chrome.storage.local.get([h,p]),n=(t[p]||{})[e];if(t[h]===!1&&(!n||n.type===`local`)){T(e);return}if(n?.url){D(e,n);return}for(let t=0;t<5;t++){t>0&&await new Promise(e=>setTimeout(e,1e3));let n=((await chrome.storage.local.get(p))[p]||{})[e];if(n?.url){D(e,n);return}}u.warn(`airglow`,`no source registered for app '${e}' after 5 attempts`),document.getElementById(`loading`).textContent=`App '${e}' not found. Is an app source reachable?`}function D(t,n){let r=n.url.replace(/\/+$/,``),i=null,a=null,o=0,s=!1,c=null,l=``;chrome.storage.local.get(m).then(e=>{let n=(Array.isArray(e[m])?e[m]:[]).find(e=>e?.id===t);n?.name&&(document.title=n.name)}).catch(e=>{u.warn(`airglow`,`cached manifest title lookup failed: ${e instanceof Error?e.message:String(e)}`)});function d(e=!1){let n=new URLSearchParams(x);return e&&n.set(`_airglow_reload`,String(Date.now())),`${r}/api/apps/${t}/ui?${n.toString()}`}function p(e=!1){let n=new URLSearchParams;e&&n.set(`_airglow_reload`,String(Date.now()));let i=n.toString();return`${r}/api/apps/${t}/ui-bundle${i?`?${i}`:``}`}function h(e=!1){let n=new URLSearchParams(x);return n.set(`app`,t),n.set(`nonce`,l),e&&n.set(`_airglow_reload`,String(Date.now())),chrome.runtime.getURL(`app-ui-sandbox.html?${n.toString()}`)}function S(e){return new Promise(t=>setTimeout(t,e))}function C(e){return e===408||e===409||e===425||e===429||e>=500&&e<=599}async function w(t){let r=``,i=n.type===`cloud`?await e({requireSession:!0}):{};for(let e=0;e<=y.length;e++)try{let n=await fetch(t,{headers:i,signal:AbortSignal.timeout(_)});if(!n.ok&&C(n.status)&&e<y.length){r=`UI bundle request failed with HTTP ${n.status}`,await S(y[e]);continue}return n}catch(t){if(r=t instanceof Error?t.message:String(t),e<y.length){await S(y[e]);continue}throw Error(`UI bundle request failed after ${y.length+1} attempts: ${r}`)}throw Error(`UI bundle request failed: ${r}`)}function T(e){let t=document.getElementById(`loading`);t||(t=document.createElement(`div`),t.id=`loading`,document.body.appendChild(t)),t.textContent=e}function E(){a&&=(clearTimeout(a),null)}function D(){document.getElementById(`airglow-app-crash`)?.remove(),s=!1}function k(e){return[e.name?`${e.name}: ${e.message}`:e.message,e.filename?`${e.filename}:${e.lineno??0}:${e.colno??0}`:``,e.stack||``].filter(Boolean).join(`

`)}function A(e,t,n){s=!0,E();let r=document.getElementById(`airglow-app-crash`);r&&r.remove();let i=document.createElement(`div`);i.id=`airglow-app-crash`,i.style.cssText=[`position:fixed`,`inset:0`,`z-index:2147483647`,`display:flex`,`align-items:center`,`justify-content:center`,`padding:24px`,`background:#f5f5f4`,`color:#1c1917`,`font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`].join(`;`);let a=n?k(n):``;i.innerHTML=`
      <div style="width:min(640px,100%);border:1px solid #e7e5e4;border-radius:8px;background:#fff;padding:20px;box-shadow:0 12px 32px rgba(28,25,23,.12)">
        <div style="font-size:13px;color:#78716c;margin-bottom:6px">Airglow app crashed</div>
        <div style="font-size:20px;font-weight:650;line-height:1.25;margin-bottom:8px">${O(e)}</div>
        <div style="font-size:14px;line-height:1.5;color:#57534e;margin-bottom:16px">${O(t)}</div>
        ${a?`<pre style="max-height:220px;overflow:auto;white-space:pre-wrap;background:#fafaf9;border:1px solid #e7e5e4;border-radius:6px;padding:12px;font-size:12px;line-height:1.45;color:#44403c;margin-bottom:16px">${O(a)}</pre>`:``}
        <div style="display:flex;gap:8px;align-items:center">
          <button id="airglow-reload-app" style="height:36px;padding:0 14px;border:0;border-radius:999px;background:#1c1917;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Reload app</button>
          <button id="airglow-reload-extension" style="height:36px;padding:0 14px;border:1px solid #d6d3d1;border-radius:999px;background:#fff;color:#44403c;font-size:14px;font-weight:600;cursor:pointer">Reload extension</button>
        </div>
      </div>
    `,document.body.appendChild(i),document.getElementById(`airglow-reload-app`)?.addEventListener(`click`,()=>M(!0)),document.getElementById(`airglow-reload-extension`)?.addEventListener(`click`,()=>chrome.runtime.reload())}function j(){E(),a=setTimeout(()=>{let e=v[o];if(e!==void 0){o++,T(`App did not load. Retrying ${o}/${v.length}...`),window.setTimeout(()=>M(!0),e);return}A(`App '${t}' did not finish loading`,`The UI iframe did not fire a load event. This is usually a dev server, network, or bundle problem. Reloading the app iframe is enough; you should not need to restart the whole extension.`)},g)}function M(e=!1){if(D(),T(`Loading...`),i){if(n.type===`cloud`){E(),N(e).catch(e=>{A(`App '${t}' failed to load`,e instanceof Error?e.message:String(e))});return}i.setAttribute(`sandbox`,`allow-scripts allow-same-origin allow-forms`),i.src=d(e),j()}}async function N(e=!1){if(!i)return;let n=await w(p(e));if(!n.ok){let e=`${n.status}`;try{let t=await n.json();t?.error&&(e=typeof t.error==`string`?t.error:JSON.stringify(t.error))}catch{}throw Error(`UI bundle request failed: ${e}`)}l=crypto.randomUUID(),c={sdk:f(t),code:await n.text()},i.setAttribute(`sandbox`,`allow-scripts allow-forms`),j(),i.src=h(e)}function P(e){let t=typeof e?.url==`string`?e.url:``;if(!t)return``;try{let e=new URL(t);return e.hostname?` for ${e.hostname}`:``}catch{return``}}function F(e){switch(e?.type){case`airglow:openTab`:return`Airglow app "${t}" wants to open a browser tab${P(e)}. Allow this action?`;case`airglow:openWindow`:return`Airglow app "${t}" wants to open a browser window${P(e)}. Allow this action?`;case`airglow:identity:launchWebAuthFlow`:return`Airglow app "${t}" wants to open an authentication window${P(e)}. Allow this action?`;default:return null}}function I(e,n){let r=F(n);if(r&&!window.confirm(r)){e?.postMessage({_airglow_response:!0,_callId:n._callId,error:`User approval is required for this action`,code:`RUNTIME_USER_APPROVAL_DENIED`},`*`);return}let i={...n,_appId:t,...r?{[b]:!0}:{}};chrome.runtime.sendMessage(i,t=>{let r=chrome.runtime.lastError?{error:chrome.runtime.lastError.message||`Chrome runtime message failed`,code:`CHROME_RUNTIME_ERROR`}:t||{};e?.postMessage({_airglow_response:!0,_callId:n._callId,...r},`*`)})}window.addEventListener(`message`,e=>{if(!i||e.source!==i.contentWindow)return;let n=e.source,r=e.data;if(r?._airglow_ui_ready&&r.appId===t){document.body.dataset.airglowAppUiReady=`true`;return}if(r?._airglow_app_error&&r.appId===t){s||A(`App '${t}' hit an unhandled error`,`The app iframe is still isolated. You can reload only this app without restarting the extension.`,r);return}r?._airglow&&I(n,r)}),i=document.createElement(`iframe`),i.style.cssText=`position:fixed;inset:0;width:100%;height:100%;border:none;`,i.setAttribute(`sandbox`,`allow-scripts allow-same-origin allow-forms`),i.setAttribute(`allow`,`clipboard-read; clipboard-write`),i.onload=()=>{o=0,E(),document.getElementById(`loading`)?.remove(),c&&i?.contentWindow&&(i.contentWindow.postMessage({type:`airglow:ui:run`,appId:t,nonce:l,...c},`*`),c=null)},i.onerror=()=>{A(`App '${t}' failed to load`,`The browser reported an iframe load error. Reloading this app iframe should recover after a transient server or network issue.`)},document.body.appendChild(i),M(!1)}function O(e){let t=document.createElement(`div`);return t.textContent=e||``,t.innerHTML}