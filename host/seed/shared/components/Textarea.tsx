import React from 'react';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function Textarea({ className = '', style, ...props }: TextareaProps) {
  return (
    <textarea
      className={`w-full rounded-sm border px-3 py-2 outline-none resize-y ${/\btext-(xs|sm|base|lg|xl|2xl|3xl)\b/.test(className) ? '' : 'text-sm'} ${className}`}
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
