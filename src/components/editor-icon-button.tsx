'use client';

import { forwardRef } from 'react';
import { Button, type ButtonProps } from './ui/button';
import { TooltipHint } from './ui/tooltip';

// The wrapper keeps hints available even when the button is disabled.
export const EditorIconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string; hint?: string }>(
  function EditorIconButton({ label, hint = label, className = '', children, ...props }, ref) {
    return <TooltipHint content={hint}><span className="inline-flex"><Button ref={ref} type="button" variant="ghost" size="icon" className={`editor-icon-button ${className}`} aria-label={label} {...props}>{children}</Button></span></TooltipHint>;
  },
);
