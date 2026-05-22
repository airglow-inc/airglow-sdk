import React from 'react';

interface SidebarProps {
  title: string;
  children: React.ReactNode;
}

export function Sidebar({ title, children }: SidebarProps) {
  return (
    <aside
      className="w-[240px] flex-shrink-0 border-r flex flex-col h-screen"
      style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--oat)' }}
    >
      <div className="px-5 pt-5 pb-6">
        <span className="text-base font-bold tracking-tight" style={{ color: 'var(--gray-800)' }}>
          {title}
        </span>
      </div>
      <nav className="flex-1 px-3 space-y-1 min-h-0 flex flex-col">
        {children}
      </nav>
    </aside>
  );
}

interface NavItemProps {
  icon: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  label: string;
  active?: boolean;
  onClick?: () => void;
  trailing?: React.ReactNode;
}

export function NavItem({ icon: Icon, label, active, onClick, trailing }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm no-underline transition-colors w-full text-left cursor-pointer ${
        active ? 'font-medium' : ''
      }`}
      style={active
        ? { background: 'var(--border-secondary)', color: 'var(--gray-800)' }
        : { color: 'var(--gray-600)', background: 'transparent' }
      }
    >
      <Icon size={18} />
      {label}
      {trailing && <span className="ml-auto">{trailing}</span>}
    </button>
  );
}
