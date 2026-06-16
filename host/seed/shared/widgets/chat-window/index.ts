import iconSvg from '../../assets/icon.svg';

// ── Types ──

export interface ImageAttachment {
  base64: string;
  mediaType: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text?: string;
  /** Images attached to this message (for display) */
  images?: ImageAttachment[];
  /** Custom element to render instead of a text bubble */
  element?: HTMLElement;
}

export interface ChatWindowConfig {
  /** Used for element IDs and data-testid (e.g. "ghqa", "sheets") */
  prefix: string;
  /** Pill label (e.g. "Ask about this repo") */
  pillText: string;
  /** Chat panel header (e.g. "Sheets Helper") */
  panelTitle: string;
  /** Empty state text (e.g. "Ask how to do anything in Sheets") */
  emptyText: string;
  /** Input placeholder */
  inputPlaceholder?: string;
  /** Called when user sends a message. Return messages to display. */
  onSend: (question: string, images?: ImageAttachment[]) => Promise<ChatMessage[]>;
  /** Optional: called on clear to let app reset backend state */
  onClear?: () => void;
  /** Position panel above the pill instead of below (default: false) */
  panelAbove?: boolean;
  /** Pre-populate chat with messages (e.g. restored from storage) */
  initialMessages?: ChatMessage[];
}

// ── Helpers ──

function autoResize(ta: HTMLTextAreaElement, maxHeight: number) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, maxHeight) + 'px';
  ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function simpleMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code style="background:#f0eeea;padding:1px 4px;border-radius:3px;font-size:13px;">$1</code>')
    .replace(/\n/g, '<br>');
}

// ── Main ──

function readFileAsBase64(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // "data:image/png;base64,..." → strip prefix
      const base64 = dataUrl.split(',')[1];
      resolve({ base64, mediaType: file.type });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function createChatWindow(config: ChatWindowConfig) {
  const p = config.prefix;
  let messages: ChatMessage[] = config.initialMessages || [];
  let isOpen = false;
  let isLoading = false;
  let messagesEl: HTMLElement | null = null;
  let pendingImages: ImageAttachment[] = [];

  // ── Render messages ──

  let renderedCount = 0;
  let loadingEl: HTMLElement | null = null;

  function renderMessageRow(msg: ChatMessage): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `margin-bottom: 8px; display: flex; flex-direction: column; align-items: ${msg.role === 'user' ? 'flex-end' : 'flex-start'};`;

    if (msg.element) {
      row.appendChild(msg.element);
    } else {
      const bubble = document.createElement('div');
      bubble.style.cssText = msg.role === 'user'
        ? 'background: #6d9ecf; color: #fff; padding: 6px 10px; border-radius: 10px 10px 2px 10px; max-width: 90%; font-size: 15px; line-height: 1.5; word-break: break-word;'
        : 'background: #f9f8f3; color: #3a3a37; padding: 6px 10px; border-radius: 10px 10px 10px 2px; max-width: 90%; font-size: 15px; line-height: 1.5; word-break: break-word;';
      if (msg.images?.length) {
        for (const img of msg.images) {
          const el = document.createElement('img');
          el.src = `data:${img.mediaType};base64,${img.base64}`;
          el.style.cssText = 'max-width: 100%; max-height: 200px; border-radius: 6px; margin-bottom: 4px; display: block;';
          bubble.appendChild(el);
        }
      }
      if (msg.text) bubble.innerHTML += simpleMarkdown(msg.text);
      row.appendChild(bubble);
    }
    return row;
  }

  function renderMessages() {
    if (!messagesEl) return;

    // Full reset (clear was pressed)
    if (messages.length === 0) {
      messagesEl.innerHTML = '';
      renderedCount = 0;
      loadingEl?.remove();
      loadingEl = null;
      const empty = document.createElement('div');
      empty.style.cssText = 'color: #84837c; font-size: 15px; text-align: center; padding: 16px 8px;';
      empty.textContent = config.emptyText;
      messagesEl.appendChild(empty);
      return;
    }

    // Remove empty state if present and this is the first message
    if (renderedCount === 0 && messages.length > 0) {
      messagesEl.innerHTML = '';
    }

    // Remove loading indicator before appending
    loadingEl?.remove();
    loadingEl = null;

    // Append only new messages
    for (let i = renderedCount; i < messages.length; i++) {
      messagesEl.appendChild(renderMessageRow(messages[i]));
    }
    renderedCount = messages.length;

    // Show loading indicator
    if (isLoading) {
      loadingEl = document.createElement('div');
      loadingEl.style.cssText = 'margin-bottom: 8px; display: flex; flex-direction: column; align-items: flex-start;';
      const dot = document.createElement('div');
      dot.style.cssText = 'background: #f9f8f3; color: #84837c; padding: 6px 10px; border-radius: 10px 10px 10px 2px; font-size: 15px;';
      dot.textContent = '…';
      loadingEl.appendChild(dot);
      messagesEl.appendChild(loadingEl);
    }
  }

  // ── Build UI ──

  function build(container: HTMLElement) {
    // Inject styles
    if (!document.getElementById(`airglow-${p}-style`)) {
      const style = document.createElement('style');
      style.id = `airglow-${p}-style`;
      style.textContent = `[data-testid="${p}-input"]::placeholder { font-weight: 400; color: #84837c; opacity: 1; }`;
      document.head.appendChild(style);
    }

    // ── Pill ──
    const pill = document.createElement('div');
    pill.id = `airglow-${p}`;
    pill.setAttribute('data-testid', `${p}-pill-wrap`);
    pill.style.cssText = `
      display: flex; align-items: center; gap: 6px;
      padding: 6px 14px 6px 10px;
      background: #fff; border: 2px solid #e8a050;
      border-radius: 20px; cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transition: border-color 0.15s, box-shadow 0.15s;
      user-select: none;
    `;

    const icon = document.createElement('div');
    icon.style.cssText = 'flex-shrink: 0; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center;';
    icon.innerHTML = iconSvg.replace(/<svg /, '<svg width="18" height="18" style="border-radius: 3px;" ');
    pill.appendChild(icon);

    const pillLabel = document.createElement('span');
    pillLabel.setAttribute('data-testid', `${p}-pill`);
    pillLabel.style.cssText = 'font-size: 15px; color: #5b5a56; font-weight: 500; white-space: nowrap;';
    pillLabel.textContent = config.pillText;
    pill.appendChild(pillLabel);

    pill.addEventListener('mouseenter', () => { pill.style.borderColor = '#d08030'; pill.style.boxShadow = '0 2px 16px rgba(232,160,80,0.25)'; });
    pill.addEventListener('mouseleave', () => { pill.style.borderColor = '#e8a050'; pill.style.boxShadow = 'none'; });

    // Prevent events from reaching underlying editors
    for (const evt of ['mousedown', 'mouseup', 'dblclick', 'pointerdown', 'pointerup'] as const) {
      pill.addEventListener(evt, (e) => e.stopPropagation());
    }

    container.appendChild(pill);

    // ── Chat panel ──
    const chatBox = document.createElement('div');
    chatBox.setAttribute('data-testid', `${p}-panel`);
    chatBox.style.cssText = `
      display: none; position: fixed; z-index: 999999;
      width: 460px; max-height: 680px;
      border: 1.5px solid #e5e3d9;
      border-radius: 10px; overflow: hidden;
      background: #ffffff;
      box-shadow: 0 8px 30px rgba(0,0,0,0.12);
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    function positionPanel() {
      const rect = pill.getBoundingClientRect();
      if (config.panelAbove) {
        chatBox.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
        chatBox.style.right = (window.innerWidth - rect.right) + 'px';
        chatBox.style.top = 'auto';
        chatBox.style.left = 'auto';
      } else {
        chatBox.style.top = (rect.bottom + 6) + 'px';
        chatBox.style.left = Math.max(8, rect.right - 460) + 'px';
        chatBox.style.bottom = 'auto';
        chatBox.style.right = 'auto';
      }
    }

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding: 10px 14px; border-bottom: 1px solid #edece3; display: flex; justify-content: space-between; align-items: center;';

    const headerTitle = document.createElement('span');
    headerTitle.style.cssText = 'font-size: 17px; font-weight: 600; color: #3a3a37;';
    headerTitle.textContent = config.panelTitle;
    header.appendChild(headerTitle);

    const headerBtns = document.createElement('div');
    headerBtns.style.cssText = 'display: flex; gap: 6px;';

    const clearBtn = document.createElement('button');
    clearBtn.setAttribute('data-testid', `${p}-clear`);
    clearBtn.style.cssText = 'background: #eecfd1; border: none; cursor: pointer; color: #b83636; font-size: 14px; padding: 4px 14px; border-radius: 20px; font-family: inherit; font-weight: 500;';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('mouseenter', () => { clearBtn.style.background = '#e6bfc1'; });
    clearBtn.addEventListener('mouseleave', () => { clearBtn.style.background = '#eecfd1'; });
    clearBtn.addEventListener('click', () => {
      messages = [];
      isLoading = false;
      config.onClear?.();
      renderMessages();
    });

    const hideBtn = document.createElement('button');
    hideBtn.setAttribute('data-testid', `${p}-hide`);
    hideBtn.style.cssText = 'background: #f3f2ea; border: 1px solid #e5e3d9; cursor: pointer; color: #5b5a56; font-size: 14px; padding: 4px 14px; border-radius: 20px; font-family: inherit; font-weight: 500;';
    hideBtn.textContent = 'Hide';
    hideBtn.addEventListener('mouseenter', () => { hideBtn.style.background = '#edece3'; });
    hideBtn.addEventListener('mouseleave', () => { hideBtn.style.background = '#f3f2ea'; });
    hideBtn.addEventListener('click', () => {
      isOpen = false;
      chatBox.style.display = 'none';
    });

    headerBtns.appendChild(clearBtn);
    headerBtns.appendChild(hideBtn);
    header.appendChild(headerBtns);
    chatBox.appendChild(header);

    // Messages area
    messagesEl = document.createElement('div');
    messagesEl.setAttribute('data-testid', `${p}-messages`);
    messagesEl.style.cssText = 'overflow-y: auto; overflow-anchor: none; padding: 10px 14px; max-height: 540px; min-height: 60px; flex: 1;';
    renderMessages();
    chatBox.appendChild(messagesEl);

    // Input row
    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'padding: 8px 10px; border-top: 1px solid #edece3; display: flex; gap: 6px; align-items: flex-end;';

    const chatInput = document.createElement('textarea');
    chatInput.setAttribute('data-testid', `${p}-input`);
    chatInput.rows = 1;
    chatInput.placeholder = config.inputPlaceholder || 'How do I…';
    chatInput.style.cssText = `
      flex: 1; border: 1px solid #e5e3d9; border-radius: 6px;
      padding: 6px 10px; font-size: 16px; outline: none; resize: none;
      background: #fff; color: #3a3a37;
      font-family: inherit; line-height: 1.4; overflow-y: hidden;
    `;
    chatInput.addEventListener('input', () => autoResize(chatInput, 100));
    chatInput.addEventListener('focus', () => { chatInput.style.borderColor = '#d08030'; });
    chatInput.addEventListener('blur', () => { chatInput.style.borderColor = '#e5e3d9'; });

    const sendBtn = document.createElement('button');
    sendBtn.setAttribute('data-testid', `${p}-send`);
    sendBtn.style.cssText = `
      background: #dc7a5a; color: #fff; border: none; border-radius: 6px;
      padding: 6px 14px; font-size: 15px; font-weight: 500; cursor: pointer; font-family: inherit;
    `;
    sendBtn.textContent = 'Send';
    sendBtn.addEventListener('mouseenter', () => { sendBtn.style.background = '#c96a4a'; });
    sendBtn.addEventListener('mouseleave', () => { sendBtn.style.background = '#dc7a5a'; });

    // Image preview strip (between messages and input)
    const previewStrip = document.createElement('div');
    previewStrip.setAttribute('data-testid', `${p}-image-preview`);
    previewStrip.style.cssText = 'display: none; padding: 4px 10px; border-top: 1px solid #edece3; display: flex; gap: 6px; flex-wrap: wrap;';

    function renderPreviews() {
      previewStrip.innerHTML = '';
      if (pendingImages.length === 0) {
        previewStrip.style.display = 'none';
        return;
      }
      previewStrip.style.display = 'flex';
      for (let i = 0; i < pendingImages.length; i++) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position: relative; display: inline-block;';

        const img = document.createElement('img');
        img.src = `data:${pendingImages[i].mediaType};base64,${pendingImages[i].base64}`;
        img.style.cssText = 'height: 48px; border-radius: 4px; display: block;';
        wrap.appendChild(img);

        const removeBtn = document.createElement('button');
        removeBtn.style.cssText = `
          position: absolute; top: -4px; right: -4px;
          width: 16px; height: 16px; border-radius: 50%;
          background: #b83636; color: #fff; border: none;
          font-size: 11px; line-height: 1; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
        `;
        removeBtn.textContent = '\u00d7';
        const idx = i;
        removeBtn.addEventListener('click', () => {
          pendingImages.splice(idx, 1);
          renderPreviews();
        });
        wrap.appendChild(removeBtn);
        previewStrip.appendChild(wrap);
      }
    }

    // Paste handler for screenshots
    chatInput.addEventListener('paste', async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) continue;
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const attachment = await readFileAsBase64(file);
        pendingImages.push(attachment);
        renderPreviews();
      }
    });

    inputRow.appendChild(chatInput);
    inputRow.appendChild(sendBtn);
    chatBox.appendChild(previewStrip);
    chatBox.appendChild(inputRow);

    document.body.appendChild(chatBox);

    // ── Interactions ──

    function showPanel() {
      isOpen = true;
      positionPanel();
      chatBox.style.display = 'flex';
      chatInput.focus({ preventScroll: true });
    }

    pill.addEventListener('click', () => {
      if (isOpen) {
        isOpen = false;
        chatBox.style.display = 'none';
      } else {
        showPanel();
      }
    });

    const handleSend = async () => {
      const q = chatInput.value.trim();
      if ((!q && !pendingImages.length) || isLoading) return;
      chatInput.value = '';
      autoResize(chatInput, 100);
      const images = pendingImages.length ? [...pendingImages] : undefined;
      pendingImages = [];
      renderPreviews();
      messages.push({ role: 'user', text: q || undefined, images });
      isLoading = true;
      renderMessages();
      try {
        const responses = await config.onSend(q, images);
        for (const r of responses) messages.push(r);
      } catch (e: any) {
        messages.push({ role: 'assistant', text: 'Error: ' + (e.message || 'unknown') });
      }
      isLoading = false;
      renderMessages();
      chatInput.focus({ preventScroll: true });
    };

    chatInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    sendBtn.addEventListener('click', handleSend);

    window.addEventListener('scroll', () => { if (isOpen) positionPanel(); }, { passive: true });
    window.addEventListener('resize', () => { if (isOpen) positionPanel(); });

    return { pill, chatBox, positionPanel };
  }

  return {
    build,
    /** Reset state (e.g. on SPA navigation) */
    reset() {
      messagesEl = null;
      isOpen = false;
      messages = [];
      renderedCount = 0;
      loadingEl = null;
    },
  };
}
