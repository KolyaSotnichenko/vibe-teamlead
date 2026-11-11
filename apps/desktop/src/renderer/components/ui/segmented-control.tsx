/**
 * Segmented control: a few mutually exclusive options side by side in one hairline frame
 * (e.g. Open / Closed / All). A radio group: arrow keys (and Home / End) move the choice, only the
 * checked option (or the first, when none is) is in the tab order.
 */
import { useRef, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group */
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({ label, value, options, onChange, className }: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const pick = (next: T) => {
    if (next !== value) onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else return;
    e.preventDefault();
    refs.current[next]?.focus();
    pick(options[next].value);
  };
  // The group stays reachable by Tab even when the value is none of the options
  const tabbable = Math.max(0, options.findIndex((o) => o.value === value));

  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex shrink-0 border border-border', className)}>
      {options.map((option, i) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === tabbable ? 0 : -1}
            onClick={() => pick(option.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'flex h-[38px] items-center px-3 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              checked ? 'bg-card font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
