import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export function Input({ className = '', style, ...props }: InputProps) {
  return (
    <input
      className={`w-full h-10 rounded-sm border px-3 text-base outline-none ${className}`}
      style={{
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border-secondary)',
        color: 'var(--fg-primary)',
        ...style,
      }}
      {...props}
    />
  );
}
