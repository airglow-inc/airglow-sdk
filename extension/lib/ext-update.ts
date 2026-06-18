// Chrome-extension self-update check. There is no custom backend for this — we
// lean on Chrome's own Web Store update channel, which is the only thing that
// can actually swap the extension's bytes:
//
//   * requestUpdateCheck() forces an on-demand check against the Web Store
//     (the background runs it on a slow alarm). It only does anything for a
//     store-installed extension; dev/unpacked builds return 'throttled' /
//     'no_update' or throw — so the Update button simply never appears in dev.
//   * onUpdateAvailable fires (in the background) once Chrome has STAGED a newer
//     version; it applies on the next worker restart. We persist that version
//     to storage so both surfaces can offer an "Update" button, and reload()
//     applies it on click.

import { useEffect, useState } from 'react';

export const EXT_UPDATE_KEY = '__ext_update_available';

// Ask Chrome to check the Web Store now; persist a staged newer version if any.
export async function checkForExtUpdate(): Promise<void> {
  try {
    const res = (await chrome.runtime.requestUpdateCheck()) as unknown as { status?: string; version?: string };
    const status = res?.status ?? (res as unknown as string);
    if (status === 'update_available' && typeof res?.version === 'string') {
      await chrome.storage.local.set({ [EXT_UPDATE_KEY]: res.version });
    }
  } catch {
    /* dev/unpacked build, or throttled — no update path, leave the button hidden */
  }
}

// Applies a staged update: reloading lets Chrome swap in the downloaded version.
export function applyExtUpdate(): void {
  try { chrome.runtime.reload(); } catch { /* noop */ }
}

// Live "a newer version is staged" signal for the UI — the staged version
// string, or null when up to date. Reads storage and tracks it via onChanged
// (the background writes the key from onUpdateAvailable / the alarm check).
export function useExtUpdateAvailable(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    const current = chrome.runtime.getManifest().version;
    const read = (v: unknown) => setVersion(typeof v === 'string' && v !== current ? v : null);
    void chrome.storage.local.get(EXT_UPDATE_KEY).then((r) => read(r[EXT_UPDATE_KEY]));
    const onChange = (c: Record<string, chrome.storage.StorageChange>) => {
      if (EXT_UPDATE_KEY in c) read(c[EXT_UPDATE_KEY]?.newValue);
    };
    chrome.storage.local.onChanged.addListener(onChange);
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, []);
  return version;
}
