declare const airglow: any;

// ── Default modes ──

interface SearchMode {
  name: string;
  system: string;
  format: string;
  inputLabel: string;
}

const DEFAULT_MODES: SearchMode[] = [
  {
    name: 'Explain',
    system: 'Explain what the term means in the given context.',
    format: 'Context',
    inputLabel: 'Term',
  },
  {
    name: 'Translate',
    system: 'Translate into Russian. Output only the translation unless ambiguity is worth noting.',
    format: 'Context',
    inputLabel: 'Text',
  },
  {
    name: 'Rephrase',
    system: 'Suggest 2-3 better alternatives that fit the context. One per line.',
    format: 'Context',
    inputLabel: 'Phrase',
  },
];

// ── State ──

let modes: SearchMode[] = [];
let activeMode = 0;
let triggerCombo = 'meta+j';
let barEl: HTMLElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;
let contextEl: HTMLTextAreaElement | null = null;
let isVisible = false;

// ── Load config ──

async function loadConfig(): Promise<void> {
  const stored = await airglow.storage.get('askme_modes');
  modes = (stored && stored.length > 0) ? stored : DEFAULT_MODES;
  const lastMode = await airglow.storage.get('askme_last_mode');
  if (typeof lastMode === 'number' && lastMode >= 0 && lastMode < modes.length) {
    activeMode = lastMode;
  }
  const sc = await airglow.storage.get('askme_shortcut');
  if (sc) triggerCombo = sc.includes('+') ? sc : `meta+${sc}`;
}

// ── Build UI ──

function getBar(): HTMLElement {
  if (barEl) return barEl;

  // Inject font
  if (!document.querySelector('[data-askme-font]')) {
    const link = document.createElement('link');
    link.setAttribute('data-askme-font', '');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap';
    document.head.appendChild(link);
  }

  const bar = document.createElement('div');
  bar.setAttribute('data-testid', 'askme-bar');
  Object.assign(bar.style, {
    position: 'fixed',
    top: '15vh',
    right: '16px',
    zIndex: '2147483646',
    width: '360px',
    height: '70vh',
    background: 'rgba(255, 255, 255, 0.95)',
    backdropFilter: 'blur(24px) saturate(1.4)',
    WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
    border: '1px solid rgba(0, 0, 0, 0.08)',
    borderRadius: '16px',
    boxShadow: '0 12px 48px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)',
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '14px',
    color: '#1a1a1a',
    padding: '20px',
    display: 'none',
    flexDirection: 'column',
    overflow: 'hidden',
  });

  // Mode selector wrapper
  const modeWrapper = document.createElement('div');
  Object.assign(modeWrapper.style, {
    margin: '-20px -20px 16px -20px',
    padding: '16px 20px',
    flexShrink: '0',
    background: 'rgba(0, 0, 0, 0.03)',
    borderBottom: '1.5px solid rgba(0, 0, 0, 0.1)',
  });

  const modeLabel = document.createElement('div');
  modeLabel.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-4.5px;margin-right:6px;opacity:0.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Mode';
  Object.assign(modeLabel.style, {
    fontSize: '16px',
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: '8px',
  });
  modeWrapper.appendChild(modeLabel);

  // Pills row
  const pillsRow = document.createElement('div');
  pillsRow.setAttribute('data-testid', 'askme-pills');
  Object.assign(pillsRow.style, {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
  });
  modeWrapper.appendChild(pillsRow);
  bar.appendChild(modeWrapper);

  // Input label
  const inputLabel = document.createElement('div');
  inputLabel.innerHTML = '<span style="display:flex;align-items:center"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;opacity:0.5"><rect width="20" height="16" x="2" y="4" rx="2" ry="2"/><path d="M6 8h.001"/><path d="M10 8h.001"/><path d="M14 8h.001"/><path d="M18 8h.001"/><path d="M8 12h.001"/><path d="M12 12h.001"/><path d="M16 12h.001"/><path d="M7 16h10"/></svg>Input</span>';
  Object.assign(inputLabel.style, {
    fontSize: '16px',
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  });

  // Screenshot indicator (inline, right side of Input title)
  const screenshotIndicator = document.createElement('span');
  screenshotIndicator.setAttribute('data-testid', 'askme-screenshot-indicator');
  Object.assign(screenshotIndicator.style, {
    fontSize: '14px',
    fontWeight: '500',
    color: '#9a958e',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  });
  screenshotIndicator.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>Screenshot attached';
  inputLabel.appendChild(screenshotIndicator);

  bar.appendChild(inputLabel);

  // Input textarea (input2 — query/phrase, placed first)
  const i2 = document.createElement('textarea');
  i2.setAttribute('data-testid', 'askme-input2');
  Object.assign(i2.style, {
    flex: '1',
    minHeight: '60px',
    width: '100%',
    border: '1.5px solid rgba(0, 0, 0, 0.06)',
    borderRadius: '12px',
    padding: '12px 14px',
    fontSize: '14px',
    lineHeight: '1.5',
    fontFamily: 'inherit',
    background: 'rgba(0, 0, 0, 0.025)',
    color: '#1a1a1a',
    outline: 'none',
    resize: 'none',
    transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
    marginBottom: '12px',
    boxSizing: 'border-box',
  });
  i2.addEventListener('focus', () => {
    i2.style.borderColor = 'rgba(208, 128, 48, 0.4)';
    i2.style.background = '#fff';
    i2.style.boxShadow = '0 0 0 3px rgba(208, 128, 48, 0.08)';
  });
  i2.addEventListener('blur', () => {
    i2.style.borderColor = 'rgba(0, 0, 0, 0.06)';
    i2.style.background = 'rgba(0, 0, 0, 0.025)';
    i2.style.boxShadow = 'none';
  });
  bar.appendChild(i2);

  // Context label
  const contextLabel = document.createElement('div');
  contextLabel.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-4.5px;margin-right:6px;opacity:0.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Context';
  Object.assign(contextLabel.style, {
    fontSize: '16px',
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: '8px',
  });
  bar.appendChild(contextLabel);

  // Context textarea (input1)
  const i1 = document.createElement('textarea');
  i1.setAttribute('data-testid', 'askme-input1');
  i1.placeholder = 'Context (optional)';
  Object.assign(i1.style, {
    flex: '1',
    minHeight: '60px',
    border: '1.5px solid rgba(0, 0, 0, 0.06)',
    borderRadius: '12px',
    padding: '12px 14px',
    fontSize: '14px',
    lineHeight: '1.5',
    fontFamily: 'inherit',
    background: 'rgba(0, 0, 0, 0.025)',
    color: '#1a1a1a',
    outline: 'none',
    resize: 'none',
    transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
    marginBottom: '10px',
  });
  i1.addEventListener('focus', () => {
    i1.style.borderColor = 'rgba(208, 128, 48, 0.4)';
    i1.style.background = '#fff';
    i1.style.boxShadow = '0 0 0 3px rgba(208, 128, 48, 0.08)';
  });
  i1.addEventListener('blur', () => {
    i1.style.borderColor = 'rgba(0, 0, 0, 0.06)';
    i1.style.background = 'rgba(0, 0, 0, 0.025)';
    i1.style.boxShadow = 'none';
  });
  bar.appendChild(i1);

  const submitBtn = document.createElement('button');
  submitBtn.setAttribute('data-testid', 'askme-submit');
  submitBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
  Object.assign(submitBtn.style, {
    width: '34px',
    height: '34px',
    borderRadius: '9px',
    border: 'none',
    background: '#d08030',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: '0',
    transition: 'background 0.15s, transform 0.1s',
  });
  submitBtn.addEventListener('mouseenter', () => { submitBtn.style.background = '#b86e28'; });
  submitBtn.addEventListener('mouseleave', () => { submitBtn.style.background = '#d08030'; });
  submitBtn.addEventListener('mousedown', () => { submitBtn.style.transform = 'scale(0.94)'; });
  submitBtn.addEventListener('mouseup', () => { submitBtn.style.transform = 'scale(1)'; });
  submitBtn.addEventListener('click', submit);

  // Footer row: hint left, submit button right
  const footerRow = document.createElement('div');
  Object.assign(footerRow.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: '0',
  });

  const hint = document.createElement('div');
  Object.assign(hint.style, {
    fontSize: '11px',
    color: 'rgba(0, 0, 0, 0.3)',
  });
  hint.textContent = 'Esc to close · Enter to submit';

  footerRow.appendChild(hint);
  footerRow.appendChild(submitBtn);
  bar.appendChild(footerRow);

  document.body.appendChild(bar);
  barEl = bar;
  inputEl = i2;
  contextEl = i1;

  return bar;
}

function renderPills(): void {
  const bar = getBar();
  const pillsRow = bar.querySelector('[data-testid="askme-pills"]')!;
  pillsRow.innerHTML = '';

  modes.forEach((mode, i) => {
    const pill = document.createElement('button');
    pill.setAttribute('data-testid', `askme-pill-${i}`);
    const isActive = i === activeMode;
    Object.assign(pill.style, {
      height: '36px',
      padding: '0 16px',
      borderRadius: '9999px',
      border: isActive ? '2px solid #c87830' : '1.5px solid rgba(0, 0, 0, 0.13)',
      background: isActive ? 'rgba(200, 120, 48, 0.12)' : '#fff',
      color: isActive ? '#c06a20' : '#1a1a1a',
      fontSize: '15px',
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      fontWeight: isActive ? '600' : '500',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      transition: 'all 0.15s',
      boxSizing: 'border-box',
    });

    const shortcut = document.createElement('span');
    shortcut.innerHTML = `<span style="font-size:0.85em">Ctrl</span>+${i + 1}`;
    Object.assign(shortcut.style, {
      fontSize: '13px',
      opacity: '0.5',
      fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace",
      fontWeight: '400',
    });

    const label = document.createElement('span');
    label.textContent = mode.name;

    pill.appendChild(shortcut);
    pill.appendChild(label);

    pill.addEventListener('click', () => {
      activeMode = i;
      renderPills();
      updateLabels();
      airglow.storage.set('askme_last_mode', i);
    });

    pillsRow.appendChild(pill);
  });
}

function updateLabels(): void {
  if (!contextEl) return;
  contextEl.placeholder = 'Context (optional)';
  if (!inputEl) return;
  const mode = modes[activeMode];
  inputEl.placeholder = mode?.inputLabel || 'Query';
}

// ── Show / Hide ──

function show(selectedText: string): void {
  const bar = getBar();
  renderPills();
  updateLabels();

  if (contextEl) {
    contextEl.value = '';
  }
  if (inputEl) {
    inputEl.value = selectedText;
  }

  bar.style.display = 'flex';
  isVisible = true;

  // Focus second input after short delay (let DOM settle)
  setTimeout(() => inputEl?.focus(), 50);
}

function hide(): void {
  if (barEl) {
    barEl.style.display = 'none';
  }
  isVisible = false;
}

// ── Submit ──

async function submit(): Promise<void> {
  if (!contextEl || !inputEl) return;
  const context = contextEl.value.trim();
  const query = inputEl.value.trim();
  if (!context && !query) return;

  const mode = modes[activeMode];

  // Capture page screenshot as context
  let screenshot: { base64: string; mediaType: string } | null = null;
  try {
    screenshot = await airglow.captureTab();
  } catch (e: any) {
    // Non-fatal — proceed without screenshot
  }

  await airglow.storage.set('askme_pending', {
    mode: {
      name: mode.name,
      system: mode.format?.trim() ? mode.system + '\n\nOutput format:\n' + mode.format.trim() : mode.system,
      format: mode.format,
      inputLabel: mode.inputLabel,
    },
    context,
    query,
    screenshot: screenshot ? { base64: screenshot.base64, mediaType: screenshot.mediaType } : null,
    timestamp: Date.now(),
  });

  await airglow.storage.set('askme_last_mode', activeMode);

  const appShellUrl = `chrome-extension://comikpjjijckpjkobpkkpnnhlcpmagic/app-shell.html?app=askme-anything&page=chat&edge=0`;
  await airglow.openWindow(appShellUrl, { width: 840, height: 600, popup: true });

  hide();
}

// ── Keyboard handler ──

function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const needMeta = parts.includes('meta');
  const needShift = parts.includes('shift');
  const needCtrl = parts.includes('ctrl');
  const needAlt = parts.includes('alt');
  return e.key.toLowerCase() === key
    && e.metaKey === needMeta
    && e.shiftKey === needShift
    && e.ctrlKey === needCtrl
    && e.altKey === needAlt;
}

document.addEventListener('keydown', async (e: KeyboardEvent) => {
  // Trigger shortcut — toggle bar (reload config to pick up changes from dashboard)
  if (e.key.length === 1 && (e.metaKey || e.ctrlKey || e.altKey)) {
    await loadConfig();
    if (matchesCombo(e, triggerCombo)) {
      e.preventDefault();
      e.stopPropagation();

      if (isVisible) {
        hide();
        return;
      }

      const sel = window.getSelection()?.toString()?.trim() || '';
      show(sel);
      return;
    }
  }

  if (!isVisible) return;

  // Esc — close
  if (e.key === 'Escape') {
    e.preventDefault();
    hide();
    return;
  }

  // Enter — submit
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    await submit();
    return;
  }

  // Ctrl+I — cycle mode
  if (e.ctrlKey && !e.metaKey && e.key === 'i') {
    e.preventDefault();
    activeMode = (activeMode + 1) % modes.length;
    renderPills();
    updateLabels();
    airglow.storage.set('askme_last_mode', activeMode);
    return;
  }

  // Ctrl+1..9 — select mode directly
  if (e.ctrlKey && !e.metaKey && e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key) - 1;
    if (idx < modes.length) {
      e.preventDefault();
      activeMode = idx;
      renderPills();
      updateLabels();
      airglow.storage.set('askme_last_mode', idx);
    }
    return;
  }
}, true);

// Close on outside click
document.addEventListener('mousedown', (e: MouseEvent) => {
  if (!isVisible || !barEl) return;
  if (!barEl.contains(e.target as Node)) {
    hide();
  }
});

// Load shortcut eagerly so the keydown handler knows which key to listen for
airglow.storage.get('askme_shortcut').then((sc: string | null) => {
  if (sc) triggerCombo = sc.includes('+') ? sc : `meta+${sc}`;
});

// ── Iframe shortcut forwarding ──
// The extension registers iframe-key-forwarder.js (via chrome.scripting) into
// about:blank/srcdoc iframes where userScripts can't reach. It forwards
// modifier+key events to the top frame via postMessage(__airglowKeyForward).

window.addEventListener('message', async (e: MessageEvent) => {
  if (!e.data?.__airglowKeyForward) return;
  await loadConfig();
  const fakeEvent = e.data as { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; selection?: string };
  if (!matchesCombo(fakeEvent as any, triggerCombo)) return;
  if (isVisible) {
    hide();
  } else {
    let sel = fakeEvent.selection || '';
    if (!sel && e.source) {
      // Canvas-based editors (Google Docs) — selection not available via DOM.
      // Ask the iframe to execCommand('copy'), then read clipboard.
      (e.source as Window).postMessage({ __airglowCopyRequest: true }, '*');
      await new Promise(r => setTimeout(r, 50));
      try { sel = await navigator.clipboard.readText(); } catch {}
    }
    show(sel);
  }
});
