// Calendar Prefill — reads prefill data from URL hash and fills Google Calendar create-event form
// Runs on calendar.google.com/*/r/create*

if (location.hash.startsWith('#airglow=')) {
  let data: PrefillData | undefined;
  try {
    const encoded = location.hash.slice('#airglow='.length);
    const bytes = atob(encoded);
    data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes, c => c.charCodeAt(0))));
  } catch (e) {
    airglow.log.error(`failed to decode hash: ${e}`);
  }

  if (data) {
    history.replaceState(null, '', location.pathname + location.search);
    airglow.log.info(`prefilling: ${JSON.stringify(data)}`);
    prefillForm(data).then(
      () => airglow.log.info('prefill complete'),
      (e) => airglow.log.error(`prefill error: ${e}`),
    );
  }
}

interface PrefillData {
  title?: string;
  date?: string;       // "April 21, 2026"
  startTime?: string;  // "14:00"
  endTime?: string;    // "15:00"
  guests?: string[];   // ["a@b.com", "c@d.com"]
  location?: string;
  description?: string;
}

async function prefillForm(data: PrefillData) {
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

  function setInput(el: HTMLInputElement, val: string) {
    el.focus();
    nativeSetter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressKey(el: Element, key: string) {
    const kc = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 9;
    el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode: kc, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, keyCode: kc, bubbles: true }));
  }

  const sel = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | null;

  // Wait for the create form to appear
  const title = await new Promise<HTMLInputElement>((resolve) => {
    const check = () => {
      const el = sel('Add title');
      if (el) resolve(el as HTMLInputElement);
      else setTimeout(check, 200);
    };
    check();
  });

  const panel = [...document.querySelectorAll('[role="heading"]')]
    .find(h => h.textContent?.trim() === 'Create')?.closest('[role="group"]');
  if (!panel) return;

  // 1. TITLE
  if (data.title) {
    setInput(title, data.title);
    title.blur();
    await wait(100);
  }

  // 2. EXPAND TIME SECTION
  const timeBtn = [...panel.querySelectorAll('button')].find(b => /\d{2}:\d{2}/.test(b.textContent || ''));
  if (timeBtn) (timeBtn as HTMLElement).click();
  await wait(150);

  // 3. START DATE
  if (data.date) {
    const startDate = sel('Start date');
    if (startDate) {
      startDate.focus();
      startDate.select();
      setInput(startDate, data.date);
      pressKey(startDate, 'Enter');
      await wait(150);
    }
  }

  // 4. START TIME
  if (data.startTime) {
    const startTime = sel('Start time');
    if (startTime) {
      startTime.focus();
      startTime.select();
      setInput(startTime, data.startTime);
      pressKey(startTime, 'Enter');
      await wait(150);
    }
  }

  // 5. END TIME
  if (data.endTime) {
    const endTime = sel('End time');
    if (endTime) {
      endTime.focus();
      endTime.select();
      setInput(endTime, data.endTime);
      pressKey(endTime, 'Enter');
      await wait(150);
    }
  }

  // Collapse time section
  title.click();
  title.blur();
  await wait(100);

  // 6. GUESTS
  if (data.guests?.length) {
    const guestsInput = sel('Guests');
    if (guestsInput) {
      for (const email of data.guests) {
        guestsInput.focus();
        setInput(guestsInput, email);
        await wait(300);
        pressKey(guestsInput, 'Enter');
        await wait(100);
      }
      guestsInput.blur();
      await wait(100);
    }
  }

  // 7. LOCATION
  if (data.location) {
    const loc = sel('Add location');
    if (loc) {
      loc.focus();
      setInput(loc, data.location);
      await wait(100);
      title.click();
      title.blur();
      await wait(100);
    }
  }

  // 8. DESCRIPTION
  if (data.description) {
    const descBtn = [...panel.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'Add description'
    ) as HTMLElement | undefined;
    if (descBtn) descBtn.click();
    await wait(150);
    const desc = document.querySelector('[aria-label="Add description"][contenteditable="true"]') as HTMLElement | null;
    if (desc) {
      desc.focus();
      await wait(50);
      document.execCommand('insertText', false, data.description);
    }
  }
}
