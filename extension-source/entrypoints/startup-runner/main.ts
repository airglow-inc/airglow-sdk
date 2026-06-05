// Offscreen document bridging background ↔ sandbox iframe for startup eval.
// Runs `startup.ts` for each app exactly once per browser launch. SDK calls
// from the running script get an `_appId` stamped on by us before being
// forwarded to background.
//
// Jobs are queued and run one-at-a-time through the same sandbox iframe; the
// sandbox is recycled (replaced) after each job so per-job globals don't leak.
// The iframe replacement IS the isolation — the old window object dies with
// the iframe, so stale messages from prior jobs can't fire post-reset.

let sandbox = document.getElementById('sandbox') as HTMLIFrameElement;

let sandboxReady = false;
const pendingJobs: StartupJob[] = [];
let activeJob: ActiveJob | null = null;

type StartupJob = {
  appId: string;
  msg: any;
};

type ActiveJob = StartupJob & {
  timeoutId: ReturnType<typeof setTimeout>;
};

function enqueueJob(job: StartupJob) {
  pendingJobs.push(job);
  pumpQueue();
}

function resetSandbox() {
  sandboxReady = false;
  const nextSandbox = document.createElement('iframe');
  nextSandbox.id = 'sandbox';
  nextSandbox.src = '/startup-sandbox.html';
  nextSandbox.style.display = 'none';
  sandbox.replaceWith(nextSandbox);
  sandbox = nextSandbox;
}

function pumpQueue() {
  if (!sandboxReady || activeJob || pendingJobs.length === 0) return;
  const next = pendingJobs.shift()!;
  activeJob = {
    ...next,
    timeoutId: setTimeout(() => {
      if (!activeJob) return;
      chrome.runtime.sendMessage({
        type: 'airglow:startup:done',
        appId: activeJob.appId,
        ok: false,
        error: `startup timeout for ${activeJob.appId}`,
      });
      activeJob = null;
      resetSandbox();
      pumpQueue();
    }, 10000),
  };
  sandbox.contentWindow?.postMessage(next.msg, '*');
}

function finishActiveJob() {
  if (!activeJob) return;
  clearTimeout(activeJob.timeoutId);
  activeJob = null;
  resetSandbox();
  pumpQueue();
}

window.addEventListener('message', (e) => {
  if (e.source !== sandbox.contentWindow) return;
  const data = e.data;
  if (!data?.type && !data?._airglow) return;

  if (data.type === 'airglow:startup:ready') {
    sandboxReady = true;
    pumpQueue();
    return;
  }

  // SDK calls from a running startup script: forward to background, stamping
  // the active job's appId so background's handler routes correctly.
  if (data._airglow) {
    if (!activeJob) return;
    chrome.runtime.sendMessage({ ...data, _appId: activeJob.appId }, (response: any) => {
      sandbox.contentWindow?.postMessage(
        { _airglow_response: true, _callId: data._callId, ...response },
        '*',
      );
    });
    return;
  }

  if (data.type === 'airglow:startup:done') {
    if (!activeJob) return;
    chrome.runtime.sendMessage({ ...data, appId: activeJob.appId });
    finishActiveJob();
    return;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'airglow:startup:run') {
    enqueueJob({ appId: String(msg.appId || ''), msg });
  }
  return false;
});

console.log('[Offscreen] Document loaded and ready');
