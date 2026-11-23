'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>, React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(
  ({ className, ...props }, ref) => <CheckboxPrimitive.Root ref={ref} data-slot="checkbox" className={cn('peer size-4 shrink-0 rounded-sm bg-secondary text-foreground shadow-[inset_0_0_0_1px_var(--ui-focus)] focus-visible:outline-none disabled:cursor-default disabled:opacity-40 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground', className)} {...props}>
    <CheckboxPrimitive.Indicator className="flex items-center justify-center"><Check className="size-3" strokeWidth={2.5} /></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>,
);
Checkbox.displayName = 'Checkbox';
export { Checkbox };
