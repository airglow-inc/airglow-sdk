// Pinned strips that sit between the sidepanel header and the message stream:
// the current-app pill and the agent's task plan. Extracted so the design-mock
// page (entrypoints/planmock) renders the exact same components as the app.

import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, ListChecks } from 'lucide-react';

export type PlanItem = { text: string; done: boolean };

// Current-app context, designed to sit inside the top header (not as its own
// strip): "Working on", a blue dot, then the app name — all in the regular UI
// font so it reads as part of the header chrome.
export function AppContextLine({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 max-w-full text-[13.5px]">
      <span className="shrink-0" style={{ color: 'var(--fg-tertiary)' }}>Working on</span>
      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--sky)' }} />
      <span className="truncate font-medium" style={{ color: 'var(--fg-secondary)' }}>{name}</span>
    </span>
  );
}

// The agent's task plan, pinned between the header and the message stream.
// Collapsed (default) it shows only the task currently in progress.
export function PinnedPlan({ items, defaultOpen = false }: { items: PlanItem[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const done = items.filter((it) => it.done).length;
  const total = items.length;
  const active = items.find((it) => !it.done);
  const complete = total > 0 && done === total;
  return (
    <div
      className="shrink-0 border-b px-3 pt-2 pb-2.5 relative overflow-hidden"
      style={{
        background: complete
          ? 'color-mix(in srgb, var(--plan-green) 13%, var(--bg-white))'
          : 'color-mix(in srgb, var(--plan-green) 6%, var(--bg-white))',
        borderColor: 'var(--border-tertiary)',
      }}
      data-testid="pinned-plan"
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left cursor-pointer text-[12px] px-0 py-0.5"
        style={{ background: 'transparent', border: 0 }}
      >
        <span
          className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded-full shrink-0 ${complete ? 'plan-complete-pop' : ''}`}
          style={{
            background: complete ? 'var(--plan-green-strong)' : 'color-mix(in srgb, var(--plan-green) 18%, transparent)',
            color: complete ? 'white' : 'var(--plan-green-strong)',
          }}
        >
          {complete ? <Check size={12} strokeWidth={3} /> : <ListChecks size={12} />}
        </span>
        <span className="shrink-0 font-bold tracking-wide" style={{ color: 'var(--plan-green-strong)' }}>
          {complete ? `PLAN DONE · ${total}/${total}` : `PLAN ${done}/${total}`}
        </span>
        {!open && (complete ? (
          <span className="truncate font-medium text-[12.5px]" style={{ color: 'var(--plan-green-strong)' }}>all steps complete</span>
        ) : active ? (
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="plan-pulse-dot shrink-0" />
            <span className="truncate thinking-shimmer-green text-[12.5px]">{active.text}</span>
          </span>
        ) : null)}
        {open
          ? <ChevronDown size={13} className="ml-auto shrink-0" style={{ color: 'var(--plan-green-strong)' }} />
          : <ChevronRight size={13} className="ml-auto shrink-0" style={{ color: 'var(--plan-green-strong)' }} />}
      </button>
      {open && items.map((it, i) => (
        <div key={i} className="flex items-start gap-2 py-0.5 text-[13px]" style={{ color: it.done ? 'var(--fg-tertiary)' : 'var(--fg-secondary)' }}>
          <span
            className="inline-flex items-center justify-center w-4 h-4 rounded-full border shrink-0 mt-0.5"
            style={{ borderColor: it.done ? 'var(--plan-green-strong)' : 'var(--border-secondary)', background: it.done ? 'var(--plan-green-strong)' : 'transparent' }}
          >
            {it.done && <Check size={11} color="white" strokeWidth={3} />}
          </span>
          <span className={!it.done && it === active ? 'thinking-shimmer-green' : ''} style={{ textDecoration: it.done ? 'line-through' : 'none' }}>{it.text}</span>
        </div>
      ))}
    </div>
  );
}
