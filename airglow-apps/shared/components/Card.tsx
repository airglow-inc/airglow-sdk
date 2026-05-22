import React from 'react';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function Card({ children, className = '', style, ...props }: CardProps) {
  return (
    <div
      className={`rounded-2xl p-5 border ${className}`}
      style={{
        background: 'var(--bg-white)',
        borderColor: 'var(--border-tertiary)',
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}
