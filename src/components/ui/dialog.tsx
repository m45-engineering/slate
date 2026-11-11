'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(
  ({ className, children, ...props }, ref) => <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/20" />
    <DialogPrimitive.Content ref={ref} data-slot="dialog-content" className={cn('fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_48px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-background p-6 text-foreground shadow-[0_16px_64px_rgba(0,0,0,0.18)] outline-none', className)} {...props}>{children}</DialogPrimitive.Content>
  </DialogPrimitive.Portal>,
);
DialogContent.displayName = 'DialogContent';
const DialogTitle = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(
  ({ className, ...props }, ref) => <DialogPrimitive.Title ref={ref} className={cn('text-xl font-medium tracking-tight', className)} {...props} />,
);
DialogTitle.displayName = 'DialogTitle';
const DialogDescription = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(
  ({ className, ...props }, ref) => <DialogPrimitive.Description ref={ref} className={cn('mt-3 text-[13px] leading-relaxed text-muted-foreground', className)} {...props} />,
);
DialogDescription.displayName = 'DialogDescription';
function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex justify-end gap-2', className)} {...props} />;
}
export { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogFooter };
