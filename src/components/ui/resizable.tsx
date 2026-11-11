'use client';

import type { ComponentProps } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { cn } from '@/lib/utils';

function ResizablePanelGroup({ className, ...props }: ComponentProps<typeof Group>) {
  return <Group className={cn('flex h-full w-full', className)} {...props} />;
}

const ResizablePanel = Panel;

function ResizableHandle({ className, ...props }: ComponentProps<typeof Separator>) {
  return <Separator className={cn('relative w-1 shrink-0 focus-visible:outline-none', className)} {...props} />;
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
