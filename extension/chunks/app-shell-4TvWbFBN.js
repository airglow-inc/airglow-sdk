import"./_virtual_wxt-html-plugins-Ch_nAHUK.js";var e=`__airglow_logs`,t=1e3;function n(e){let n={info:0,warn:0,error:0};for(let t of e)n[t.level]++;let r={info:Math.max(0,n.info-t),warn:Math.max(0,n.warn-t),error:Math.max(0,n.error-t)};if(r.info===0&&r.warn===0&&r.error===0)return e;let i={...r},a=[];for(let t of e){if(i[t.level]>0){i[t.level]--;continue}a.push(t)}return a}var r=[],i=null,a=300;function o(){i||=setTimeout(s,a)}async function s(){if(i=null,r.length===0)return;let t=r;r=[];try{let r=await chrome.storage.local.get(e),i=n((Array.isArray(r[e])?r[e]:[]).concat(t));await chrome.storage.local.set({[e]:i})}catch{r=t.concat(r)}}function c(e,t,n,i){let a={ts:Date.now(),level:e,source:t,message:n};i&&(a.stack=i),r.push(a),o();let s=`[${t}]`;e===`error`?console.error(s,n,i||``):e===`warn`?console.warn(s,n):console.log(s,n)}var l={info:(e,t)=>c(`info`,e,t),warn:(e,t)=>c(`warn`,e,t),error:(e,t,n)=>c(`error`,e,t,n),async getAll(){let t=await chrome.storage.local.get(e);return Array.isArray(t[e])?t[e]:[]},async clear(){r=[],await chrome.storage.local.remove(e)}},u=`0.1.0-beta.1`;function d(e){return`
(function() {
  const APP_ID = ${JSON.stringify(e)};
  const SDK_VERSION = ${JSON.stringify(u)};
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
    platform,
    identity,
    captureTab,
    openWindow,
    openWindowAndWaitClose,
    openTab,
  };
})();
`}var f=`__app_sources`,p=`__app_manifests`,m=`__dev_server_online`,h=12e3,g=8e3,_=[1e3,3e3],v=[500,1500],y=new URLSearchParams(window.location.search),b=y.get(`app`);b?S(b):document.getElementById(`loading`).textContent=`Missing app parameter`;function x(e){document.body.innerHTML=``;let t=`#b91c1c`,n=`#1c1917`,r=document.createElement(`div`);r.id=`airglow-app-offline`,r.style.cssText=`position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:#f5f5f4;color:${n};`,r.innerHTML=`
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
  `,document.body.appendChild(r),document.getElementById(`airglow-offline-retry`)?.addEventListener(`click`,()=>location.reload());let i=e=>{m in e&&e[m].newValue===!0&&(chrome.storage.local.onChanged.removeListener(i),location.reload())};chrome.storage.local.onChanged.addListener(i)}async function S(e){let t=await chrome.storage.local.get([m,f]),n=(t[f]||{})[e];if(t[m]===!1&&(!n||n.type===`local`)){x(e);return}if(n?.url){C(e,n);return}for(let t=0;t<5;t++){t>0&&await new Promise(e=>setTimeout(e,1e3));let n=((await chrome.storage.local.get(f))[f]||{})[e];if(n?.url){C(e,n);return}}l.warn(`airglow`,`no source registered for app '${e}' after 5 attempts`),document.getElementById(`loading`).textContent=`App '${e}' not found. Is an app source reachable?`}function C(e,t){let n=t.url.replace(/\/+$/,``),r=null,i=null,a=0,o=!1,s=null,c=``,u=!1;chrome.storage.local.get(p).then(t=>{let n=(Array.isArray(t[p])?t[p]:[]).find(t=>t?.id===e);n?.name&&(document.title=n.name)}).catch(e=>{l.warn(`airglow`,`cached manifest title lookup failed: ${e instanceof Error?e.message:String(e)}`)});function f(t=!1){let r=new URLSearchParams(y);return t&&r.set(`_airglow_reload`,String(Date.now())),`${n}/api/apps/${e}/ui?${r.toString()}`}function m(t=!1){let r=new URLSearchParams;t&&r.set(`_airglow_reload`,String(Date.now()));let i=r.toString();return`${n}/api/apps/${e}/ui-bundle${i?`?${i}`:``}`}function b(t=!1){let n=new URLSearchParams(y);return n.set(`app`,e),n.set(`nonce`,c),t&&n.set(`_airglow_reload`,String(Date.now())),chrome.runtime.getURL(`app-ui-sandbox.html?${n.toString()}`)}function x(){u||(u=!0,chrome.runtime.sendMessage({type:`airglow:track-app-used`,appId:e,sourceType:t.type,action:`open_ui`,surface:`app_shell`},()=>{chrome.runtime.lastError}))}function S(e){return new Promise(t=>setTimeout(t,e))}function C(e){return e===408||e===409||e===425||e===429||e>=500&&e<=599}async function T(e){let t=``;for(let n=0;n<=v.length;n++)try{let r=await fetch(e,{signal:AbortSignal.timeout(g)});if(!r.ok&&C(r.status)&&n<v.length){t=`UI bundle request failed with HTTP ${r.status}`,await S(v[n]);continue}return r}catch(e){if(t=e instanceof Error?e.message:String(e),n<v.length){await S(v[n]);continue}throw Error(`UI bundle request failed after ${v.length+1} attempts: ${t}`)}throw Error(`UI bundle request failed: ${t}`)}function E(e){let t=document.getElementById(`loading`);t||(t=document.createElement(`div`),t.id=`loading`,document.body.appendChild(t)),t.textContent=e}function D(){i&&=(clearTimeout(i),null)}function O(){document.getElementById(`airglow-app-crash`)?.remove(),o=!1}function k(e){return[e.name?`${e.name}: ${e.message}`:e.message,e.filename?`${e.filename}:${e.lineno??0}:${e.colno??0}`:``,e.stack||``].filter(Boolean).join(`

`)}function A(e,t,n){o=!0,D();let r=document.getElementById(`airglow-app-crash`);r&&r.remove();let i=document.createElement(`div`);i.id=`airglow-app-crash`,i.style.cssText=[`position:fixed`,`inset:0`,`z-index:2147483647`,`display:flex`,`align-items:center`,`justify-content:center`,`padding:24px`,`background:#f5f5f4`,`color:#1c1917`,`font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`].join(`;`);let a=n?k(n):``;i.innerHTML=`
      <div style="width:min(640px,100%);border:1px solid #e7e5e4;border-radius:8px;background:#fff;padding:20px;box-shadow:0 12px 32px rgba(28,25,23,.12)">
        <div style="font-size:13px;color:#78716c;margin-bottom:6px">Airglow app crashed</div>
        <div style="font-size:20px;font-weight:650;line-height:1.25;margin-bottom:8px">${w(e)}</div>
        <div style="font-size:14px;line-height:1.5;color:#57534e;margin-bottom:16px">${w(t)}</div>
        ${a?`<pre style="max-height:220px;overflow:auto;white-space:pre-wrap;background:#fafaf9;border:1px solid #e7e5e4;border-radius:6px;padding:12px;font-size:12px;line-height:1.45;color:#44403c;margin-bottom:16px">${w(a)}</pre>`:``}
        <div style="display:flex;gap:8px;align-items:center">
          <button id="airglow-reload-app" style="height:36px;padding:0 14px;border:0;border-radius:999px;background:#1c1917;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Reload app</button>
          <button id="airglow-reload-extension" style="height:36px;padding:0 14px;border:1px solid #d6d3d1;border-radius:999px;background:#fff;color:#44403c;font-size:14px;font-weight:600;cursor:pointer">Reload extension</button>
        </div>
      </div>
    `,document.body.appendChild(i),document.getElementById(`airglow-reload-app`)?.addEventListener(`click`,()=>M(!0)),document.getElementById(`airglow-reload-extension`)?.addEventListener(`click`,()=>chrome.runtime.reload())}function j(){D(),i=setTimeout(()=>{let t=_[a];if(t!==void 0){a++,E(`App did not load. Retrying ${a}/${_.length}...`),window.setTimeout(()=>M(!0),t);return}A(`App '${e}' did not finish loading`,`The UI iframe did not fire a load event. This is usually a dev server, network, or bundle problem. Reloading the app iframe is enough; you should not need to restart the whole extension.`)},h)}function M(n=!1){if(O(),E(`Loading...`),r){if(t.type===`cloud`){D(),N(n).catch(t=>{A(`App '${e}' failed to load`,t instanceof Error?t.message:String(t))});return}r.setAttribute(`sandbox`,`allow-scripts allow-same-origin allow-forms`),r.src=f(n),j()}}async function N(t=!1){if(!r)return;let n=await T(m(t));if(!n.ok){let e=`${n.status}`;try{let t=await n.json();t?.error&&(e=typeof t.error==`string`?t.error:JSON.stringify(t.error))}catch{}throw Error(`UI bundle request failed: ${e}`)}c=crypto.randomUUID(),s={sdk:d(e),code:await n.text()},r.setAttribute(`sandbox`,`allow-scripts allow-forms`),j(),r.src=b(t)}window.addEventListener(`message`,t=>{if(!r||t.source!==r.contentWindow)return;let n=t.source,i=t.data;if(i?._airglow_app_error&&i.appId===e){o||A(`App '${e}' hit an unhandled error`,`The app iframe is still isolated. You can reload only this app without restarting the extension.`,i);return}if(!i?._airglow)return;let a={...i,_appId:e};chrome.runtime.sendMessage(a,e=>{let t=chrome.runtime.lastError?{error:chrome.runtime.lastError.message||`Chrome runtime message failed`,code:`CHROME_RUNTIME_ERROR`}:e||{};n?.postMessage({_airglow_response:!0,_callId:i._callId,...t},`*`)})}),r=document.createElement(`iframe`),r.style.cssText=`position:fixed;inset:0;width:100%;height:100%;border:none;`,r.setAttribute(`sandbox`,`allow-scripts allow-same-origin allow-forms`),r.setAttribute(`allow`,`clipboard-read; clipboard-write`),r.onload=()=>{a=0,D(),document.getElementById(`loading`)?.remove(),x(),s&&r?.contentWindow&&(r.contentWindow.postMessage({type:`airglow:ui:run`,appId:e,nonce:c,...s},`*`),s=null)},r.onerror=()=>{A(`App '${e}' failed to load`,`The browser reported an iframe load error. Reloading this app iframe should recover after a transient server or network issue.`)},document.body.appendChild(r),M(!1)}function w(e){let t=document.createElement(`div`);return t.textContent=e||``,t.innerHTML}