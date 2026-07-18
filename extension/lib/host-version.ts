// The running Airglow host (daemon) version, read from its lightweight
// /api/healthz ({ version }). Returns null until known / while the daemon is
// offline. Used by the dashboard sidebar + sidepanel footers to show the host
// version next to the extension version. Re-probes on a slow interval and when
// the daemon origin / connection changes (host (re)connects).

import { useEffect, useState } from 'react';
import { fetchHostVersion } from './host-probe';

const DAEMON_ORIGIN_KEY = '__daemon_origin';

export function useHostVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    async function probe() {
      const v = await fetchHostVersion();
      if (alive) setVersion(v);
    }
    void probe();
    const id = setInterval(() => { void probe(); }, 15000);
    const onChange = (c: Record<string, chrome.storage.StorageChange>) => {
      if (DAEMON_ORIGIN_KEY in c || '__native_host_connected' in c || '__host_version_poke' in c) void probe();
    };
    chrome.storage.local.onChanged.addListener(onChange);
    return () => { alive = false; clearInterval(id); chrome.storage.local.onChanged.removeListener(onChange); };
  }, []);
  return version;
}
