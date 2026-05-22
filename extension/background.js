var background=(function(){function e(e){return e==null||typeof e==`function`?{main:e}:e}var t=globalThis.browser?.runtime?.id?globalThis.browser:globalThis.chrome,n=`__airglow_logs`,r=1e3,i=[],a=null,o=300;function s(){a||=setTimeout(c,o)}async function c(){if(a=null,i.length===0)return;let e=i;i=[];try{let t=await chrome.storage.local.get(n),i=(Array.isArray(t[n])?t[n]:[]).concat(e);i.length>r&&i.splice(0,i.length-r),await chrome.storage.local.set({[n]:i})}catch{i=e.concat(i)}}function l(e,t,n,r){let a={ts:Date.now(),level:e,source:t,message:n};r&&(a.stack=r),i.push(a),s();let o=`[${t}]`;e===`error`?console.error(o,n,r||``):e===`warn`?console.warn(o,n):console.log(o,n)}var u={info:(e,t)=>l(`info`,e,t),warn:(e,t)=>l(`warn`,e,t),error:(e,t,n)=>l(`error`,e,t,n),async getAll(){let e=await chrome.storage.local.get(n);return Array.isArray(e[n])?e[n]:[]},async clear(){i=[],await chrome.storage.local.remove(n)}},d=`__airglow_user_email`,f=`EMAIL_REQUIRED`,p=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,m=new Set([`airglow:identity:getUserEmail`,`airglow:identity:setUserEmail`,`airglow:log`]);function h(e){if(typeof e!=`string`)return;let t=e.trim().toLowerCase();return p.test(t)?t:void 0}function g(e){return typeof e==`string`?!m.has(e):!1}function _(e){return{error:`Airglow needs your email before apps can run.`,code:f,onboardingUrl:e}}var v=`airglow:app:`,y=`airglow:secret:`,b=`airglow:dev-secret:`,x=520,S=720,C=`__airglow_user_id`,w=`__airglow_user_secret`;async function ee(){let e=await chrome.storage.local.get([d,C,w]),t=typeof e[C]==`string`?e[C]:``,n=typeof e[w]==`string`?e[w]:``,r={};return t||(t=`ag_${crypto.randomUUID()}`,r[C]=t),n||(n=crypto.randomUUID().replace(/-/g,``)+crypto.randomUUID().replace(/-/g,``),r[w]=n),Object.keys(r).length>0&&await chrome.storage.local.set(r),{email:h(e[d]),userId:t,userSecret:n}}async function te(e,t,n,r){let i=new URL(e),a=i.origin,o=await chrome.tabs.query({url:`${i.protocol}//${i.hostname}/*`}),s,c=!1;o.length>0?s=o[0].id:(s=(await chrome.tabs.create({url:a,active:!1})).id,c=!0,await new Promise(e=>{let t=(n,r)=>{n===s&&r.status===`complete`&&(chrome.tabs.onUpdated.removeListener(t),e())};chrome.tabs.onUpdated.addListener(t)}));try{let i=(await chrome.scripting.executeScript({target:{tabId:s},world:`MAIN`,func:async(e,t,n,r)=>{try{let i=await fetch(e,{method:t,headers:n||void 0,body:r||void 0,credentials:`include`}),a=await i.text();return{status:i.status,body:a}}catch(e){return{status:0,body:`fetchViaPage error: `+e.message}}},args:[e,t||`GET`,n||{},r||null]}))?.[0]?.result;if(!i)throw Error(`No result from page fetch`);let a;try{a=JSON.parse(i.body)}catch{a=i.body}return{status:i.status,body:a}}finally{c&&chrome.tabs.remove(s).catch(()=>{})}}var T=[],E=new Map;function ne(e){T=e,E.clear();for(let t of e)E.set(t.id,t._source.url)}function D(){return T}function re(e,t){let n=T.find(t=>t.id===e);return n?.secrets?t in n.secrets:!1}function O(e,t){try{let n=new URL(t),r=e.match(/^(\*|https?|ftp):\/\/(\*|(?:\*\.)?[^/]*)\/(.*)$/);if(!r)return!1;let[,i,a,o]=r;if(i!==`*`&&i!==n.protocol.replace(`:`,``))return!1;if(a!==`*`){if(a.startsWith(`*.`)){let e=a.slice(2);if(n.hostname!==e&&!n.hostname.endsWith(`.`+e))return!1}else if(n.hostname!==a)return!1}return RegExp(`^/`+o.replace(/[.+?^${}()|[\]\\]/g,`\\$&`).replace(/\*/g,`.*`)+`$`).test(n.pathname+n.search)}catch{return!1}}function k(e,t){let n=T.find(t=>t.id===e);return n?.host_permissions?.length?n.host_permissions.some(e=>O(e,t)):!1}var A;function ie(e){A=e}function j(e,t,n){if(!e?._airglow)return!1;let r=e._appId;if(!r)return n({error:`missing _appId`}),!0;if(t.url)try{let e=new URL(t.url).searchParams.get(`app`);if(e&&e!==r)return n({error:`appId mismatch: claimed ${r}, sender has ${e}`}),!0}catch{}if(!T.some(e=>e.id===r))return n({error:`unknown appId: ${r}`}),!0;let i=t.userScriptWorldId;if(i&&i!==`airglow:${r}`)return n({error:`appId mismatch: claimed ${r}, world is ${i}`}),!0;let a=e=>`${v}${r}:${e}`;return g(e.type)?(chrome.storage.local.get(d,i=>{if(!h(i.__airglow_user_email)){n(_(chrome.runtime.getURL(`dashboard.html`)));return}M(e,r,a,t,n)||n({error:`unknown message type: ${e.type}`,code:`UNKNOWN_MESSAGE_TYPE`})}),!0):M(e,r,a,t,n)}function M(e,t,n,r,i){try{switch(e.type){case`airglow:storage:get`:if(re(t,e.key)){let t=`${y}${e.key}`,n=`${b}${e.key}`;chrome.storage.local.get([t,n],e=>{i({value:e[t]??e[n]??void 0})})}else chrome.storage.local.get(n(e.key),t=>{i({value:t[n(e.key)]})});return!0;case`airglow:storage:set`:return chrome.storage.local.set({[n(e.key)]:e.value},()=>{i({ok:!0})}),!0;case`airglow:storage:delete`:return chrome.storage.local.remove(n(e.key),()=>{i({ok:!0})}),!0;case`airglow:storage:list`:{let e=`${v}${t}:`;return chrome.storage.local.get(null,t=>{i({keys:Object.keys(t).filter(t=>t.startsWith(e)).map(t=>t.slice(e.length))})}),!0}case`airglow:fetch`:if(e.includeCookies){if(!k(t,e.url))return i({error:`app "${t}" lacks host_permissions for ${new URL(e.url).hostname}`}),!0;te(e.url,e.method,e.headers,e.body).then(e=>i(e)).catch(e=>i({error:e.message}))}else{let t={method:e.method||`GET`,headers:e.headers,body:e.body};fetch(e.url,t).then(async e=>{let t=await e.text(),n;try{n=JSON.parse(t)}catch{n=t}i({status:e.status,body:n})}).catch(e=>i({error:e.message}))}return!0;case`airglow:log`:{let n=e.level===`error`?`error`:e.level===`warn`?`warn`:`info`,a=e.data?`${e.message} ${typeof e.data==`string`?e.data:JSON.stringify(e.data)}`:e.message;return u[n](t,a,e.stack),A?.(t,n,r),i({ok:!0}),!0}case`airglow:rpc`:{let n=E.get(t);return n?(ee().then(r=>fetch(`${n}/api/apps/${t}/rpc/${e.functionName}`,{method:`POST`,headers:{"Content-Type":`application/json`,"X-Airglow-User-Id":r.userId,"X-Airglow-User-Secret":r.userSecret,...r.email?{"X-Airglow-User-Email":r.email}:{}},body:JSON.stringify(e.payload)})).then(async t=>{let n=await t.text(),r;try{r=JSON.parse(n)}catch{r=n}if(!t.ok){let n=r&&typeof r==`object`?r:{};i({error:typeof n.error==`string`?n.error:`RPC '${e.functionName}' failed with HTTP ${t.status}`,code:typeof n.code==`string`?n.code:`RPC_HTTP_ERROR`,status:t.status,requestId:typeof n.requestId==`string`?n.requestId:void 0,details:r});return}i({result:r})}).catch(e=>i({error:e.message,code:`RPC_NETWORK_ERROR`})),!0):(console.error(`[airglow] RPC failed: no source registered for app '${t}'`),i({error:`No source registered for app '${t}'. Is the dev server running?`,code:`RPC_SOURCE_NOT_REGISTERED`}),!0)}case`airglow:identity:getRedirectURL`:return i({url:chrome.identity.getRedirectURL()}),!0;case`airglow:identity:getUserEmail`:return chrome.storage.local.get(d,e=>{i({email:h(e[d])})}),!0;case`airglow:identity:setUserEmail`:{let t=h(e.email);return t?(chrome.storage.local.set({[d]:t},()=>{i({ok:!0,email:t})}),!0):(i({error:`Enter a valid email address.`,code:`INVALID_EMAIL`}),!0)}case`airglow:identity:launchWebAuthFlow`:{let t=chrome.identity.getRedirectURL(),n=e.width||x,r=e.height||S;return chrome.windows.getCurrent(a=>{let o=(a.left??0)+Math.round(((a.width??1200)-n)/2),s=(a.top??0)+Math.round(((a.height??800)-r)/2);chrome.windows.create({url:e.url,type:`popup`,width:n,height:r,left:o,top:s},e=>{let n=e?.id,r=e?.tabs?.[0]?.id;if(n==null){i({error:`no window created`});return}let a=e=>{e.tabId!==r||e.frameId!==0||e.url.startsWith(t)&&(chrome.webNavigation.onBeforeNavigate.removeListener(a),chrome.windows.onRemoved.removeListener(o),chrome.windows.remove(n,()=>{}),i({redirectUrl:e.url}))},o=e=>{e===n&&(chrome.webNavigation.onBeforeNavigate.removeListener(a),chrome.windows.onRemoved.removeListener(o),i({error:`User closed the auth window`}))};chrome.webNavigation.onBeforeNavigate.addListener(a),chrome.windows.onRemoved.addListener(o)})}),!0}case`airglow:openWindow`:{let t=e.width||x,n=e.height||S;return chrome.windows.getCurrent(r=>{let a=e.left??(r.left??0)+Math.round(((r.width??1200)-t)/2),o=e.top??(r.top??0)+Math.round(((r.height??800)-n)/2),s=e.popup===!1?`normal`:`popup`;chrome.windows.create({url:e.url,type:s,width:t,height:n,left:a,top:o},t=>{if(!e.waitClose){i({ok:!0,windowId:t?.id});return}let n=t?.id;if(n==null){i({ok:!1,error:`no window created`});return}let r=e=>{e===n&&(chrome.windows.onRemoved.removeListener(r),i({ok:!0}))};chrome.windows.onRemoved.addListener(r)})}),!0}case`airglow:captureTab`:{let e=r.tab?.id;return e==null?(i({error:`no sender tab`}),!0):(chrome.tabs.get(e,e=>{if(chrome.runtime.lastError||!e.windowId){i({error:`cannot get tab window`});return}chrome.tabs.captureVisibleTab(e.windowId,{format:`jpeg`,quality:90},e=>{if(chrome.runtime.lastError){i({error:chrome.runtime.lastError.message});return}let t=e.split(`,`)[1];i({base64:t,mediaType:`image/jpeg`})})}),!0)}case`airglow:platform:registerRedirects`:{let n=`__platform:redirects`;return chrome.storage.local.get(n,r=>{let a=r[n]||{};a[t]=e.rules||[],chrome.storage.local.set({[n]:a},()=>{console.log(`[airglow/${t}] Stored ${(e.rules||[]).length} redirect rule(s)`),i({ok:!0})})}),!0}case`airglow:platform:allowIframes`:{let n=`__platform:iframeAllow`;return chrome.storage.local.get(n,r=>{let a=r[n]||{};a[t]={domains:e.domains||[],initiators:e.initiators||[]},chrome.storage.local.set({[n]:a},()=>{console.log(`[airglow/${t}] Stored ${(e.domains||[]).length} iframe-allow domain(s)`),i({ok:!0})})}),!0}default:return!1}}catch(n){return u.error(t,`handler error for ${e.type}: ${n instanceof Error?n.message:String(n)}`,n instanceof Error?n.stack:void 0),i({error:`handler error: ${n instanceof Error?n.message:String(n)}`}),!0}}var N=`0.1.0-beta.1`;function P(e){return`
(function() {
  const APP_ID = ${JSON.stringify(e)};
  const SDK_VERSION = ${JSON.stringify(N)};
  const EMAIL_REQUIRED_CODE = 'EMAIL_REQUIRED';
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

  function normalizeUserEmail(value) {
    if (typeof value !== 'string') return undefined;
    const email = value.trim().toLowerCase();
    return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) ? email : undefined;
  }

  function collectUserEmail(onboardingUrl) {
    const email = normalizeUserEmail(globalThis.prompt?.(
      'Airglow needs your email before apps can run. It is stored locally in this extension.',
      ''
    ));
    if (!email) {
      const error = makeAirglowError({
        error: 'Enter a valid email address to use Airglow apps.',
        code: EMAIL_REQUIRED_CODE,
        onboardingUrl,
      });
      return Promise.reject(error);
    }
    return sendMsg({ type: 'airglow:identity:setUserEmail', email }).then(() => email);
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
          } else if (response?.code === EMAIL_REQUIRED_CODE && payload.type !== 'airglow:identity:setUserEmail') {
            try {
              await collectUserEmail(response.onboardingUrl);
              resolve(await sendMsg(payload));
            } catch (error) {
              reject(error);
            }
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

  globalThis.airglow = {
    sdkVersion: SDK_VERSION,
    fetch: airglowFetch,
    storage,
    log,
    rpc,
    platform,
    identity,
    captureTab,
    openWindow,
    openWindowAndWaitClose,
  };
})();
`}var F=`__dev_port`,ae=3001;async function oe(){return new Promise(e=>{chrome.storage.local.get(F,t=>{e(t[F]||ae)})})}async function se(){return{url:`http://127.0.0.1:${await oe()}`,type:`local`}}var ce=`__app_sources`,I=`__app_manifests`;function L(e){return e.visibility!==`hidden`}async function R(){let e=await se();try{return(await fetch(`${e.url}/api/apps/manifests`,{signal:AbortSignal.timeout(2e3)})).ok?[e]:[]}catch{return[]}}async function z(){let e=await R();if(e.length===0)return[];let t=new Map,n={};await Promise.all(e.map(async e=>{try{let r=await fetch(`${e.url}/api/apps/manifests`);if(!r.ok)return;let i=await r.json();for(let r of i){if(!L(r)||t.has(r.id))continue;let i={...r,_source:e};t.set(r.id,i),n[r.id]=e}}catch(t){u.warn(`airglow`,`manifest fetch failed for ${e.url}: ${t}`)}}));let r=Array.from(t.values());return await chrome.storage.local.set({[ce]:n,[I]:r}),r}async function B(e,t){let n=await fetch(`${e._source.url}/api/apps/${e.id}/userscript?file=${encodeURIComponent(t)}`);if(!n.ok){let r=`${n.status}`;try{let e=await n.json();e?.error&&(r=e.error)}catch{}throw Error(`${e.id}/${t}: ${r}`)}return await n.text()}async function V(e,t,n){await chrome.userScripts.unregister();let r=[],i=new Set;for(let t of e){if(!t.userscripts?.length)continue;let e=P(t.id),n=`airglow:${t.id}`;i.add(n);for(let i of t.userscripts)try{let a=await B(t,i.file),o=`//# sourceURL=airglow-app://${t.id}/${i.file}\n`;r.push({id:`${t.id}__${i.file.replace(/[\/\.]/g,`_`)}`,matches:i.matches,allFrames:i.allFrames??!1,js:[{code:o+e+`
`+a}],runAt:i.runAt||`document_idle`,world:`USER_SCRIPT`,worldId:n})}catch(e){let n=e?.message||String(e);console.error(`[airglow] Failed to load userscript ${t.id}/${i.file}:`,e),u.error(t.id,`Build failed for ${i.file}: ${n}`)}}if(r.length>0){for(let e of i)await chrome.userScripts.configureWorld({worldId:e,csp:`script-src 'self'`,messaging:!0});if(await chrome.userScripts.register(r),u.info(`airglow`,`registered ${r.length} userscript(s)`),!n?.skipReload){let e=(t?r.filter(e=>t.some(t=>e.id.startsWith(t+`__`))):r).flatMap(e=>e.matches??[]);if(e.length>0){let t=await chrome.tabs.query({}),n=0;for(let r of t)!r.url||!r.id||e.some(e=>RegExp(`^`+e.replace(/[.+?^${}()|[\]\\]/g,`\\$&`).replace(/\*/g,`.*`)+`$`).test(r.url))&&(chrome.tabs.reload(r.id),n++);n>0&&u.info(`airglow`,`reloaded ${n} tab(s) for userscript injection`)}}}let a=`airglow-iframe-key-forwarder`;try{await chrome.scripting.unregisterContentScripts({ids:[a]})}catch{}try{await chrome.scripting.registerContentScripts([{id:a,matches:[`<all_urls>`],allFrames:!0,matchOriginAsFallback:!0,runAt:`document_idle`,js:[`iframe-key-forwarder.js`]}])}catch(e){u.warn(`airglow`,`iframe key forwarder registration failed: ${e.message}`)}for(let t of e)await le(t)}async function H(e){let t=e.filter(e=>e.startup);if(t.length!==0)for(let e of t)try{let t=await fetch(`${e._source.url}/api/apps/${e.id}/userscript?file=${encodeURIComponent(e.startup)}&format=esm`);if(!t.ok){console.error(`[airglow] Failed to fetch startup for ${e.id}: ${t.status}`);continue}let n=await t.text(),r=P(e.id);await U(e.id,n,r),console.log(`[airglow] Ran startup for ${e.id}`)}catch(t){console.error(`[airglow] Startup failed for ${e.id}:`,t)}}async function U(e,t,n){try{await chrome.offscreen.createDocument({url:`startup-runner.html`,reasons:[`DOM_PARSER`],justification:`Run app startup scripts in sandboxed iframe`})}catch(e){if(!e.message?.includes(`already exists`))throw e}await new Promise((r,i)=>{let a=setTimeout(()=>{chrome.runtime.onMessage.removeListener(o),i(Error(`startup timeout for ${e}`))},1e4),o=t=>{t?.type===`airglow:startup:done`&&t.appId===e&&(clearTimeout(a),chrome.runtime.onMessage.removeListener(o),t.ok?r():i(Error(t.error)))};chrome.runtime.onMessage.addListener(o),chrome.runtime.sendMessage({type:`airglow:startup:run`,appId:e,code:t,sdk:n})});try{await chrome.offscreen.closeDocument()}catch{}}var W=`airglow:dev-secret:`,G=`airglow:secret:`;async function le(e){if(e._source.type===`local`)try{let t=await fetch(`${e._source.url}/api/apps/${e.id}/settings`);if(!t.ok)return;let n=await t.json(),r=new Set(Object.keys(e.secrets||{})),i=Object.keys(n).filter(e=>r.has(e));if(i.length===0)return;let a=i.map(e=>`${G}${e}`),o=await chrome.storage.local.get(a),s={};for(let e of i){if(o[`${G}${e}`]!==void 0){console.warn(`[airglow] CLIENT_${e} already set by user, ignoring .env value`);continue}s[`${W}${e}`]=n[e]}Object.keys(s).length>0&&(await chrome.storage.local.set(s),console.log(`[airglow] Loaded ${Object.keys(s).length} dev secret(s) for ${e.id}`))}catch(t){console.error(`[airglow] Failed to load dev secrets for ${e.id}:`,t)}}async function ue(){let e=await chrome.storage.local.get(null),t=Object.keys(e).filter(e=>e.startsWith(W));t.length!==0&&(await chrome.storage.local.remove(t),console.log(`[airglow] Cleaned up ${t.length} dev secret(s)`))}function K(e,t){return typeof e==`boolean`?e:t}function de(e,t){return typeof e==`number`&&Number.isFinite(e)&&e>=0?Math.round(e):t}function fe(e){if(typeof e!=`string`)return``;let t=e.trim();if(!t)return``;try{let e=new URL(t);if(e.protocol===`http:`||e.protocol===`https:`)return e.toString()}catch{}return``}var q={enableNativeHost:!0,localManifestPollMs:5e3,enableFeedback:!0,feedbackEndpoint:``},J={enableNativeHost:K(q.enableNativeHost,!0),localManifestPollMs:de(q.localManifestPollMs,5e3),enableFeedback:K(q.enableFeedback,!0),feedbackEndpoint:fe(q.feedbackEndpoint)},Y=e=>u.info(`airglow`,e),pe=e(()=>{Y(`service worker started`);let e=`__platform:iframeAllow`,n=9900;async function r(){let t=(await chrome.storage.local.get(e))[e]||{},r=Array.from({length:100},(e,t)=>n+t),i=[],a=n;for(let e of Object.keys(t)){let{domains:n,initiators:r}=t[e];for(let e of n){if(a>9999)break;i.push({id:a++,priority:1,action:{type:`modifyHeaders`,responseHeaders:[{header:`content-security-policy`,operation:`remove`},{header:`x-frame-options`,operation:`remove`}],requestHeaders:[{header:`Sec-Fetch-Dest`,operation:`set`,value:`document`}]},condition:{urlFilter:`||${e}`,resourceTypes:[`sub_frame`,`main_frame`],...r.length>0?{initiatorDomains:r}:{}}})}}await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:r,addRules:i}),Y(`synced ${i.length} iframe CSP bypass rule(s)`)}r().catch(e=>u.error(`airglow`,`iframe rules sync failed: `+e.message)),chrome.storage.local.onChanged.addListener(t=>{e in t&&r()});let i=new Map,a=0;async function o(){return new Promise(e=>{chrome.storage.local.get(`__disabled_apps`,t=>{e(new Set(t.__disabled_apps||[]))})})}async function s(e=!1,t=!1){let n=++a,r=await z();if(r.length===0){await ue(),i.clear();return}let s=await o(),c=r.filter(e=>!s.has(e.id));ne(r);let l=[],d=new Set(c.map(e=>e.id));for(let e of c){let t=e._hash||e.version;i.get(e.id)!==t&&(l.push(e.id),i.set(e.id,t))}let f=!1;for(let e of i.keys())d.has(e)||(i.delete(e),f=!0);!e&&!f&&l.length===0||n===a&&(Y(`reloading apps: ${(e?c.map(e=>e.id):l).join(`, `)}`),await V(c,e?void 0:l,{skipReload:t}).catch(e=>u.error(`airglow`,`userscript registration failed: ${e}`)),H(e?c:c.filter(e=>l.includes(e.id))).catch(e=>u.error(`airglow`,`startup scripts failed: ${e}`)))}let c;function l(){c&&clearInterval(c),c=void 0,!(J.localManifestPollMs<=0)&&(c=setInterval(()=>{s().catch(e=>u.error(`airglow`,`local app refresh failed: ${e}`))},J.localManifestPollMs))}s(!0).catch(e=>u.error(`airglow`,`initial app load failed: ${e}`)),l();let d=`com.airglow.spy`,f=new Set,p=null;function m(){try{p=chrome.runtime.connectNative(d),Y(`native host connected: ${d}`),p.onMessage.addListener(g),p.onDisconnect.addListener(()=>{Y(`native host disconnected: ${chrome.runtime.lastError?.message||`disconnected`}`),p=null,setTimeout(m,3e3)})}catch(e){u.error(`airglow`,`connectNative failed: ${e}`)}}function h(e){if(p)try{p.postMessage(e)}catch(e){u.error(`airglow`,`postMessage failed: ${e}`)}}function g(e){!e||typeof e!=`object`||(e.type===`attach`&&typeof e.tabId==`number`?(f.add(e.tabId),h({type:`reply`,reqId:e.reqId,payload:{attached:e.tabId,spiedTabs:[...f]}}),_(e.tabId).catch(()=>{})):e.type===`detach`&&typeof e.tabId==`number`?(f.delete(e.tabId),h({type:`reply`,reqId:e.reqId,payload:{detached:e.tabId,spiedTabs:[...f]}})):e.type===`logs`?u.getAll().then(t=>{h({type:`reply`,reqId:e.reqId,payload:{entries:t}})}):e.type===`reload`?(Y(`reload requested via native host`),chrome.runtime.reload()):e.type===`ready`&&Y(`native host ready, http on :${e.httpPort}`))}async function _(e){await chrome.scripting.executeScript({target:{tabId:e,allFrames:!1},world:`MAIN`,injectImmediately:!0,func:v}),await chrome.scripting.executeScript({target:{tabId:e,allFrames:!1},injectImmediately:!0,func:y})}function v(){let e=window;if(e.__airglowSpy)return;e.__airglowSpy=!0;let t=e=>window.postMessage({__airglowNet:!0,entry:e},`*`),n=window.fetch,r=async(e,t)=>{if(typeof e==`string`)return e.slice(0,2e4);if(e instanceof URLSearchParams)return e.toString().slice(0,2e4);if(e instanceof ArrayBuffer)return new TextDecoder().decode(e).slice(0,2e4);if(e instanceof Blob)return(await e.text()).slice(0,2e4);if(!e&&t instanceof Request)try{return(await t.clone().text()).slice(0,2e4)}catch{return null}return null};window.fetch=async function(...e){let i=e[0],a=e[1]||{},o=typeof i==`string`?i:i&&i.url||``,s=(a.method||i&&i.method||`GET`).toUpperCase(),c=r(a.body,i),l={},u=a.headers||i&&i.headers;if(u&&typeof u.forEach==`function`)u.forEach((e,t)=>{l[t]=e});else if(Array.isArray(u))for(let[e,t]of u)l[e]=t;else if(u&&typeof u==`object`)for(let e of Object.keys(u))l[e]=String(u[e]);let d=Date.now(),f=await c,p=await n.apply(this,e),m={};return p.headers.forEach((e,t)=>{m[t]=e}),p.clone().text().then(e=>t({url:o,method:s,reqBody:f,reqHeaders:l,status:p.status,resHeaders:m,resBody:e.slice(0,2e4),ts:d,transport:`fetch`})).catch(()=>{}),p};let i=XMLHttpRequest.prototype.open,a=XMLHttpRequest.prototype.send,o=XMLHttpRequest.prototype.setRequestHeader;XMLHttpRequest.prototype.open=function(e,t){return this.__url=t,this.__method=e,this.__reqHeaders={},i.apply(this,arguments)},XMLHttpRequest.prototype.setRequestHeader=function(e,t){return(this.__reqHeaders=this.__reqHeaders||{})[e]=t,o.apply(this,arguments)},XMLHttpRequest.prototype.send=function(e){let n=Date.now();return this.addEventListener(`load`,()=>{let r={};try{this.getAllResponseHeaders().split(/\r?\n/).forEach(e=>{let t=e.indexOf(`:`);t>0&&(r[e.slice(0,t).trim().toLowerCase()]=e.slice(t+1).trim())})}catch{}t({url:this.__url,method:(this.__method||`GET`).toUpperCase(),reqBody:typeof e==`string`?e.slice(0,2e4):null,reqHeaders:this.__reqHeaders||{},status:this.status,resHeaders:r,resBody:typeof this.responseText==`string`?this.responseText.slice(0,2e4):null,ts:n,transport:`xhr`})}),a.apply(this,arguments)}}function y(){let e=window;e.__airglowSpyBridge||(e.__airglowSpyBridge=!0,window.addEventListener(`message`,e=>{if(e.source!==window)return;let t=e.data;if(!(!t||!t.__airglowNet||!t.entry))try{chrome.runtime.sendMessage({type:`airglow:net-capture`,entry:t.entry})}catch{}}))}J.enableNativeHost?m():Y(`native host disabled for this build profile`);let b=`__platform:redirects`,x=[];function S(){chrome.storage.local.get([b,`__disabled_apps`],e=>{let t=e[b]||{},n=new Set(e.__disabled_apps||[]);x=[];for(let[e,r]of Object.entries(t))if(!n.has(e))for(let t of r)x.push({appId:e,domains:t.domains,target:t.target});x.length>0&&Y(`loaded ${x.length} redirect rule(s)`)})}S(),chrome.storage.local.onChanged.addListener(e=>{(b in e||`__disabled_apps`in e)&&S()});function C(e){let t=e.split(`.`);for(let e of x)for(let n=0;n<t.length-1;n++){let r=t.slice(n).join(`.`);if(e.domains.includes(r))return{appId:e.appId,domain:r,target:e.target}}}chrome.webNavigation.onCommitted.addListener(e=>{if(e.frameId===0)try{let t=C(new URL(e.url).hostname);if(t){let n=t.target.replace(`airglow://`,``);chrome.tabs.update(e.tabId,{url:chrome.runtime.getURL(`app-shell.html?app=${n}&site=${t.domain}`)});return}f.has(e.tabId)&&_(e.tabId).catch(e=>u.error(`airglow`,`spy inject failed: ${e}`))}catch{}}),chrome.runtime.onInstalled.addListener(e=>{e.reason===`install`&&chrome.tabs.create({url:chrome.runtime.getURL(`dashboard.html`)})}),chrome.action.onClicked.addListener(()=>{chrome.tabs.create({url:chrome.runtime.getURL(`dashboard.html`)})}),chrome.commands.onCommand.addListener(e=>{e===`reload-extension`&&chrome.runtime.reload()});let w=new Map;ie((e,t,n)=>{if(t!==`error`&&t!==`warn`)return;let r=n?.tab?.id;r&&(w.has(r)||w.set(r,new Set),w.get(r).add(e))}),chrome.tabs.onRemoved.addListener(e=>{w.delete(e)}),chrome.runtime.onUserScriptMessage.addListener((e,t,n)=>j(e,t,n)),t.runtime.onMessage.addListener((e,t,n)=>{if(j(e,t,n))return!0;if(e?.type===`airglow:open-dashboard`){let t=e.page?`?page=${e.page}`:``;chrome.tabs.create({url:chrome.runtime.getURL(`dashboard.html${t}`)});return}if(e?.type===`airglow:open-app`){chrome.tabs.create({url:chrome.runtime.getURL(`app-shell.html?app=${e.appId}`)});return}if(e?.type===`airglow:reload-apps`)return s(!0).then(()=>n({ok:!0})).catch(e=>n({error:e.message})),!0;if(e?.type===`airglow:reload-app`){let t=e.appId;return i.delete(t),s().then(()=>n({ok:!0})).catch(e=>n({error:e.message})),!0}if(e?.type===`airglow:toggle-app`){let t=e.appId;return o().then(async e=>{let r=e.has(t);r?e.delete(t):e.add(t),await chrome.storage.local.set({__disabled_apps:Array.from(e)}),i.delete(t),await s(!0,!0),n({ok:!0,disabled:!r})}).catch(e=>n({error:e.message})),!0}if(e?.type===`airglow:get-page-apps`){let r=e.url,i=e.appId,a=t?.tab?.id,s=a?w.get(a):void 0,c=D();return o().then(e=>{let t=[],a=new Set;if(i){let r=c.find(e=>e.id===i);r&&t.push({id:r.id,name:r.name,disabled:e.has(r.id),hasError:s?.has(r.id)}),n({apps:t});return}for(let n of c)n.userscripts?.some(e=>e.matches.some(e=>RegExp(`^`+e.replace(/[.+?^${}()|[\]\\]/g,`\\$&`).replace(/\*/g,`.*`)+`$`).test(r)))&&(a.add(n.id),t.push({id:n.id,name:n.name,disabled:e.has(n.id),hasError:s?.has(n.id)}));try{let n=new URL(r).hostname;for(let r of x){if(a.has(r.appId))continue;let i=n.split(`.`);for(let n=0;n<i.length-1;n++)if(r.domains.includes(i.slice(n).join(`.`))){let n=c.find(e=>e.id===r.appId);n&&(a.add(n.id),t.push({id:n.id,name:n.name,disabled:e.has(n.id),hasError:s?.has(n.id)}));break}}}catch{}chrome.storage.local.get(`__platform:redirects`,i=>{let o=i[`__platform:redirects`]||{};try{let n=new URL(r).hostname;for(let[r,i]of Object.entries(o))if(!a.has(r))for(let o of i){let i=n.split(`.`);for(let n=0;n<i.length-1;n++)if(o.domains.includes(i.slice(n).join(`.`))){let n=c.find(e=>e.id===r);n&&(a.add(n.id),t.push({id:n.id,name:n.name,disabled:e.has(n.id),hasError:s?.has(n.id)}));break}}}catch{}n({apps:t})})}),!0}if(e?.type===`airglow:clear-app-storage`){let t=`airglow:app:${e.appId}:`;return chrome.storage.local.get(null,e=>{let r=Object.keys(e).filter(e=>e.startsWith(t));chrome.storage.local.remove(r,()=>{n({ok:!0,removed:r.length})})}),!0}if(e?.type===`airglow:secrets:get-all`)return chrome.storage.local.get(null,e=>{let t={},r={};for(let[n,i]of Object.entries(e))n.startsWith(`airglow:secret:`)&&(t[n.slice(15)]=i),n.startsWith(`airglow:dev-secret:`)&&(r[n.slice(19)]=i);n({userSecrets:t,devSecrets:r})}),!0;if(e?.type===`airglow:secrets:save`){let t={},r=[];for(let[n,i]of Object.entries(e.secrets))i?t[`airglow:secret:${n}`]=i:r.push(`airglow:secret:${n}`);let i=[];return Object.keys(t).length>0&&i.push(chrome.storage.local.set(t)),r.length>0&&i.push(chrome.storage.local.remove(r)),Promise.all(i).then(()=>n({ok:!0})),!0}if(e?.type===`airglow:get-manifests`)return n({manifests:D()}),!0;if(e?.type===`airglow:logs:get`)return u.getAll().then(e=>n({entries:e})),!0;if(e?.type===`airglow:logs:clear`)return u.clear().then(()=>n({ok:!0})),!0;if(e?.type===`airglow:net-capture`){let n=t?.tab?.id;return n!=null&&f.has(n)&&h({type:`capture`,entry:{tabId:n,...e.entry}}),!1}if(e?.type===`airglow:proxy-fetch`)return fetch(e.url,{method:e.method||`GET`,headers:e.headers,body:e.body}).then(async e=>{let t=await e.text(),r;try{r=JSON.parse(t)}catch{r=t}n({status:e.status,body:r})}).catch(e=>n({error:e.message})),!0})}),X=class{constructor(e){if(e===`<all_urls>`)this.isAllUrls=!0,this.protocolMatches=[...X.PROTOCOLS],this.hostnameMatch=`*`,this.pathnameMatch=`*`;else{let t=/(.*):\/\/(.*?)(\/.*)/.exec(e);if(t==null)throw new Q(e,`Incorrect format`);let[n,r,i,a]=t;me(e,r),he(e,i),this.protocolMatches=r===`*`?[`http`,`https`]:[r],this.hostnameMatch=i,this.pathnameMatch=a}}includes(e){if(this.isAllUrls)return!0;let t=typeof e==`string`?new URL(e):e instanceof Location?new URL(e.href):e;return!!this.protocolMatches.find(e=>{if(e===`http`)return this.isHttpMatch(t);if(e===`https`)return this.isHttpsMatch(t);if(e===`file`)return this.isFileMatch(t);if(e===`ftp`)return this.isFtpMatch(t);if(e===`urn`)return this.isUrnMatch(t)})}isHttpMatch(e){return e.protocol===`http:`&&this.isHostPathMatch(e)}isHttpsMatch(e){return e.protocol===`https:`&&this.isHostPathMatch(e)}isHostPathMatch(e){if(!this.hostnameMatch||!this.pathnameMatch)return!1;let t=[this.convertPatternToRegex(this.hostnameMatch),this.convertPatternToRegex(this.hostnameMatch.replace(/^\*\./,``))],n=this.convertPatternToRegex(this.pathnameMatch);return!!t.find(t=>t.test(e.hostname))&&n.test(e.pathname)}isFileMatch(e){throw Error(`Not implemented: file:// pattern matching. Open a PR to add support`)}isFtpMatch(e){throw Error(`Not implemented: ftp:// pattern matching. Open a PR to add support`)}isUrnMatch(e){throw Error(`Not implemented: urn:// pattern matching. Open a PR to add support`)}convertPatternToRegex(e){let t=this.escapeForRegex(e).replace(/\\\*/g,`.*`);return RegExp(`^${t}$`)}escapeForRegex(e){return e.replace(/[.*+?^${}()|[\]\\]/g,`\\$&`)}},Z=X;Z.PROTOCOLS=[`http`,`https`,`file`,`ftp`,`urn`];var Q=class extends Error{constructor(e,t){super(`Invalid match pattern "${e}": ${t}`)}};function me(e,t){if(!Z.PROTOCOLS.includes(t)&&t!==`*`)throw new Q(e,`${t} not a valid protocol (${Z.PROTOCOLS.join(`, `)})`)}function he(e,t){if(t.includes(`:`))throw new Q(e,`Hostname cannot include a port`);if(t.includes(`*`)&&t.length>1&&!t.startsWith(`*.`))throw new Q(e,`If using a wildcard (*), it must go at the start of the hostname`)}var ge={debug:(...e)=>([...e],void 0),log:(...e)=>([...e],void 0),warn:(...e)=>([...e],void 0),error:(...e)=>([...e],void 0)},$;try{$=pe.main(),$ instanceof Promise&&console.warn(`The background's main() function return a promise, but it must be synchronous`)}catch(e){throw ge.error(`The background crashed on startup!`),e}return $})();