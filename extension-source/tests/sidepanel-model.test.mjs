import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

async function loadSidepanelModel() {
  const dir = await mkdtemp(join(tmpdir(), 'airglow-sidepanel-model-'));
  const outfile = join(dir, 'sidepanel-model.mjs');
  const source = await readFile(fileURLToPath(new URL('../lib/sidepanel-model.ts', import.meta.url)), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  await writeFile(outfile, transpiled.outputText);
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return {
    ...mod,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('consent policy does not block passive reads', async () => {
  const model = await loadSidepanelModel();
  try {
    assert.equal(model.consentPolicyForAction('read_current_tab_metadata').level, 'allowed');
    assert.equal(model.consentPolicyForAction('capture_semantic_fingerprint').level, 'allowed');
    assert.equal(model.consentPolicyForAction('dom_query').level, 'allowed');
  } finally {
    await model.cleanup();
  }
});

test('consent policy uses disclosure for selected-tab screenshots', async () => {
  const model = await loadSidepanelModel();
  try {
    const policy = model.consentPolicyForAction('screenshot_selected_tab');
    assert.equal(policy.level, 'disclosure');
    assert.match(policy.label, /screenshot/i);
  } finally {
    await model.cleanup();
  }
});

test('consent policy requires approval for UX-affecting actions', async () => {
  const model = await loadSidepanelModel();
  try {
    const actions = [
      'switch_tab',
      'open_tab',
      'close_tab',
      'reload_tab',
      'navigate_tab',
      'click_page',
      'type_page',
      'submit_form',
      'scroll_page',
      'run_live_code',
      'attach_network_capture',
      'write_storage',
      'publish_app',
    ];
    for (const action of actions) {
      assert.equal(model.consentPolicyForAction(action).level, 'approval', action);
    }
  } finally {
    await model.cleanup();
  }
});

test('createAppDraft builds a deterministic review from a prompt', async () => {
  const model = await loadSidepanelModel();
  try {
    const draft = model.createAppDraft({
      prompt: 'summarize this page, take a screenshot, then click the buy button',
      target: { id: 7, windowId: 3, title: 'Product Page', url: 'https://example.test/item' },
      now: new Date('2026-06-09T10:00:00.000Z'),
      nonce: 'abc',
    });

    assert.equal(draft.id, 'draft-abc');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.name, 'Summarize This Page Take A');
    assert.equal(draft.revision, 1);
    assert.equal(draft.messages.length, 1);
    assert.equal(draft.messages[0].role, 'user');
    assert.equal(draft.messages[0].content, 'summarize this page, take a screenshot, then click the buy button');
    assert.equal(draft.target.id, 7);
    assert.ok(draft.review.readOnly.some((item) => item.action === 'capture_semantic_fingerprint'));
    assert.ok(draft.review.disclosures.some((item) => item.action === 'screenshot_selected_tab'));
    assert.ok(draft.review.approvals.some((item) => item.action === 'click_page'));
  } finally {
    await model.cleanup();
  }
});

test('appendDraftUserMessage turns a saved draft into an iterative chat update', async () => {
  const model = await loadSidepanelModel();
  try {
    const draft = model.createAppDraft({
      prompt: 'summarize this page',
      now: new Date('2026-06-09T10:00:00.000Z'),
      nonce: 'chat',
    });
    const saved = model.markDraftSaved(draft, {
      now: new Date('2026-06-09T10:01:00.000Z'),
      persistence: {
        mode: 'cloud',
        cloud: {
          appId: 'private-app',
          versionKey: 'private-app@v1',
          generatedSummary: 'Summarizes the page.',
        },
      },
      assistantMessage: 'Generated app update: Summarizes the page.',
    });
    const updated = model.appendDraftUserMessage(saved, {
      content: 'make the panel smaller and add a copy button',
      now: new Date('2026-06-09T10:02:00.000Z'),
      nonce: 'followup',
    });

    assert.equal(updated.id, draft.id);
    assert.equal(updated.status, 'draft');
    assert.equal(updated.revision, 2);
    assert.equal(updated.prompt, 'make the panel smaller and add a copy button');
    assert.deepEqual(updated.messages.map((message) => message.role), ['user', 'assistant', 'user']);
    assert.equal(updated.messages[2].id, 'msg-followup');
    assert.ok(updated.review.readOnly.some((item) => item.action === 'dom_query'));
    assert.equal(updated.persistence.cloud.appId, 'private-app');
  } finally {
    await model.cleanup();
  }
});

test('markDraftSaved keeps the draft content and updates status', async () => {
  const model = await loadSidepanelModel();
  try {
    const draft = model.createAppDraft({
      prompt: 'summarize this page',
      now: new Date('2026-06-09T10:00:00.000Z'),
      nonce: 'save',
    });
    const saved = model.markDraftSaved(draft, new Date('2026-06-09T10:01:00.000Z'));
    assert.equal(saved.id, draft.id);
    assert.equal(saved.prompt, draft.prompt);
    assert.equal(saved.status, 'saved');
    assert.equal(saved.updatedAt, '2026-06-09T10:01:00.000Z');
    assert.equal(saved.messages.length, 1);
  } finally {
    await model.cleanup();
  }
});

test('buildPrivateAppSavePayload strips local-only tab fields', async () => {
  const model = await loadSidepanelModel();
  try {
    const draft = model.createAppDraft({
      prompt: 'summarize this page and take a screenshot',
      target: {
        id: 7,
        windowId: 3,
        title: 'Product Page',
        url: 'https://example.test/item',
        favIconUrl: 'https://example.test/favicon.ico',
        status: 'complete',
      },
      now: new Date('2026-06-09T10:00:00.000Z'),
      nonce: 'payload',
    });
    const payload = model.buildPrivateAppSavePayload(draft, 'request-1');

    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.clientRequestId, 'request-1');
    assert.equal(payload.draftId, 'draft-payload');
    assert.equal(payload.target.title, 'Product Page');
    assert.equal(payload.target.url, 'https://example.test/item');
    assert.equal(payload.target.origin, 'https://example.test');
    assert.equal('id' in payload.target, false);
    assert.equal('windowId' in payload.target, false);
    assert.equal('favIconUrl' in payload.target, false);
    assert.equal('status' in payload.target, false);
    assert.deepEqual(payload.requestedActions, draft.requestedActions);
    assert.deepEqual(payload.review, draft.review);
    assert.deepEqual(payload.conversation, [{
      role: 'user',
      content: 'summarize this page and take a screenshot',
      createdAt: '2026-06-09T10:00:00.000Z',
    }]);
  } finally {
    await model.cleanup();
  }
});

test('buildPrivateAppSavePayload includes previous cloud app metadata for updates', async () => {
  const model = await loadSidepanelModel();
  try {
    const draft = model.createAppDraft({
      prompt: 'summarize this page',
      now: new Date('2026-06-09T10:00:00.000Z'),
      nonce: 'previous',
    });
    const saved = model.markDraftSaved(draft, {
      now: new Date('2026-06-09T10:01:00.000Z'),
      persistence: {
        mode: 'cloud',
        cloud: {
          appId: 'private-app',
          versionKey: 'private-app@v1',
          generatedSummary: 'Summarizes the page.',
        },
      },
      assistantMessage: 'Generated app update: Summarizes the page.',
    });
    const updated = model.appendDraftUserMessage(saved, {
      content: 'now make it compact',
      now: new Date('2026-06-09T10:02:00.000Z'),
      nonce: 'previous-2',
    });
    const payload = model.buildPrivateAppSavePayload(updated, 'request-2');

    assert.equal(payload.prompt, 'now make it compact');
    assert.deepEqual(payload.previousApp, {
      appId: 'private-app',
      versionKey: 'private-app@v1',
      generatedSummary: 'Summarizes the page.',
    });
    assert.deepEqual(payload.conversation.map((message) => message.role), ['user', 'assistant', 'user']);
  } finally {
    await model.cleanup();
  }
});

test('normalizeDraftForSave migrates legacy one-shot drafts into chat drafts', async () => {
  const model = await loadSidepanelModel();
  try {
    const legacy = {
      id: 'draft-legacy',
      name: 'Legacy Draft',
      prompt: 'summarize legacy page',
      target: null,
      requestedActions: [],
      review: { readOnly: [], disclosures: [], approvals: [] },
      status: 'draft',
      createdAt: '2026-06-09T10:00:00.000Z',
      updatedAt: '2026-06-09T10:00:00.000Z',
    };
    const normalized = model.normalizeDraftForSave(legacy, new Date('2026-06-09T10:03:00.000Z'));

    assert.equal(normalized.prompt, 'summarize legacy page');
    assert.equal(normalized.revision, 1);
    assert.deepEqual(normalized.messages, [{
      id: 'msg-migrated-user',
      role: 'user',
      content: 'summarize legacy page',
      createdAt: '2026-06-09T10:00:00.000Z',
    }]);
    assert.ok(normalized.review.readOnly.some((item) => item.action === 'dom_query'));
  } finally {
    await model.cleanup();
  }
});

test('markDraftSaved records cloud and local fallback persistence metadata', async () => {
  const model = await loadSidepanelModel();
  try {
    const draft = model.createAppDraft({
      prompt: 'summarize this page',
      now: new Date('2026-06-09T10:00:00.000Z'),
      nonce: 'persistence',
    });
    const cloudSaved = model.markDraftSaved(draft, {
      now: new Date('2026-06-09T10:01:00.000Z'),
      persistence: {
        mode: 'cloud',
        cloud: {
          appId: 'private-app',
          versionKey: 'private-app@v1',
          requestId: 'req-cloud',
          registered: true,
        },
      },
    });
    assert.equal(cloudSaved.status, 'saved');
    assert.equal(cloudSaved.persistence.mode, 'cloud');
    assert.equal(cloudSaved.persistence.savedAt, '2026-06-09T10:01:00.000Z');
    assert.equal(cloudSaved.persistence.cloud.appId, 'private-app');
    assert.equal(cloudSaved.persistence.cloud.registered, true);

    const localSaved = model.markDraftSaved(draft, {
      now: new Date('2026-06-09T10:02:00.000Z'),
      persistence: {
        mode: 'local',
        fallbackReason: {
          message: 'Save app storage is not configured',
          code: 'SAVE_APP_NOT_CONFIGURED',
          status: 503,
        },
      },
    });
    assert.equal(localSaved.status, 'saved');
    assert.equal(localSaved.persistence.mode, 'local');
    assert.equal(localSaved.persistence.fallbackReason.status, 503);
  } finally {
    await model.cleanup();
  }
});

test('formatCloudSaveFallbackNotice gives end-user messages for cloud auth failures', async () => {
  const model = await loadSidepanelModel();
  try {
    assert.equal(
      model.formatCloudSaveFallbackNotice({
        message: 'Anonymous sign-ins are disabled',
        code: 'AIRGLOW_IDENTITY_UPSTREAM_ERROR',
        status: 502,
      }),
      'Draft saved on this browser only. Airglow Cloud sign-in is not enabled yet, so this app cannot sync or run yet.',
    );
    assert.equal(
      model.formatCloudSaveFallbackNotice({
        message: 'Airglow identity storage is not configured',
        code: 'IDENTITY_NOT_CONFIGURED',
        status: 503,
      }),
      'Draft saved on this browser only. Airglow Cloud sign-in is temporarily unavailable, so this app cannot sync or run yet.',
    );
    assert.equal(
      model.formatCloudSaveFallbackNotice({
        message: 'Save app failed with HTTP 404',
        status: 404,
      }),
      'Draft saved on this browser only. This Airglow Cloud server does not support private app save yet.',
    );
    assert.equal(
      model.formatCloudSaveFallbackNotice({
        message: 'Save app network request failed: Airglow request timed out after 120000ms',
        code: 'SAVE_APP_TIMEOUT',
      }),
      'Draft saved on this browser only. Cloud generation took too long to finish, so this app cannot sync or run yet.',
    );
  } finally {
    await model.cleanup();
  }
});
