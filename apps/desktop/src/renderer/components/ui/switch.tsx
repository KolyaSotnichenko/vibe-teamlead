import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '../../lib/utils';

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      // Off: empty frame, grey thumb on the left. On: filled frame, thumb on the right.
      // Position, fill and thumb colour all change, so the state reads the same in both themes.
      'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center border border-foreground p-0.5',
      'transition-colors duration-150',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-foreground data-[state=unchecked]:bg-transparent',
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block h-[18px] w-[18px] transition-transform duration-150',
        'data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-muted-foreground',
        'data-[state=checked]:translate-x-5 data-[state=checked]:bg-background'
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
