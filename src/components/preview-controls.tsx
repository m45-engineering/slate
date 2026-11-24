import type { ComponentProps, ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from './ui/button';
import { TooltipHint } from './ui/tooltip';

export type PreviewHandle = {
  zoom(direction: 'in' | 'out' | 'reset'): void;
  find(): void;
  findNext(direction: number): void;
};

export function PreviewButton({ label, children, ...props }: ComponentProps<typeof Button> & { label: string; children: ReactNode }) {
  return <TooltipHint content={label}><Button variant="ghost" size="icon" aria-label={label} {...props}>{children}</Button></TooltipHint>;
}

export function OpenOriginal({ id, onError }: { id: string; onError(message: string): void }) {
  if (typeof window === 'undefined' || !window.slate) return null;
  return <PreviewButton label="Open in default app" onClick={async () => {
    try {
      const result = await window.slate!.openDefault(id);
      if (result.error) onError(result.error);
    } catch (error) { onError(String(error)); }
  }}><ExternalLink /></PreviewButton>;
}
