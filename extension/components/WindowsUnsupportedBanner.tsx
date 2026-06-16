// Shown in the sidepanel when the extension is running on Windows. The native
// host (daemon + connector) is macOS/Linux only (see host/src/install.ts), so
// on Windows every host-backed feature — apps, agent, browser control,
// secrets, connectors — is dead. The Chrome Web Store has no per-OS gate, so a
// Windows user can install the extension; this banner is the honest "it won't
// work here" state, shown instead of an eternal "Disconnected" spinner.

import { MonitorX } from 'lucide-react';

export function WindowsUnsupportedBanner() {
  return (
    <div
      data-testid="banner-windows-unsupported"
      className="w-full max-w-[340px] rounded-[var(--radius-md)] border p-6 text-center"
      style={{
        background: 'color-mix(in srgb, var(--error) 7%, var(--bg-white))',
        borderColor: 'color-mix(in srgb, var(--error) 28%, var(--border-tertiary))',
      }}
    >
      <div
        className="mx-auto mb-4 inline-flex items-center justify-center rounded-full"
        style={{
          width: 56,
          height: 56,
          background: 'color-mix(in srgb, var(--error) 12%, var(--bg-white))',
          color: 'var(--error)',
        }}
      >
        <MonitorX size={30} strokeWidth={1.75} />
      </div>
      <div className="text-[19px] font-semibold leading-snug" style={{ color: 'var(--fg-primary)' }}>
        Windows isn’t supported
      </div>
      <div className="mt-2 text-[14px] leading-relaxed" style={{ color: 'var(--fg-secondary)' }}>
        We’re sorry for the inconvenience. Airglow needs a native helper that doesn’t run on Windows yet.
      </div>
      <div className="mt-3 text-[12.5px]" style={{ color: 'var(--fg-tertiary)' }}>
        It works today on macOS and Linux.
      </div>
    </div>
  );
}
