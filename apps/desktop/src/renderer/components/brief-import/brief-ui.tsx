/**
 * Small controls used by the brief import dialog, drawn to the design system:
 * radius 0, no shadows, 1px ink frames, visible 2px focus ring.
 */

import { type ReactNode, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu';

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export const primaryButton = cn(
  'inline-flex min-h-11 items-center justify-center gap-2 bg-primary px-4 text-sm font-medium text-primary-foreground',
  'hover:bg-[var(--vt-ink-hover)] dark:hover:opacity-90 disabled:pointer-events-none disabled:opacity-40',
  FOCUS
);

export const secondaryButton = cn(
  'inline-flex min-h-11 items-center justify-center gap-2 border border-foreground px-4 text-sm font-medium text-foreground',
  'hover:bg-accent disabled:pointer-events-none disabled:opacity-40',
  FOCUS
);

export const ghostButton = cn(
  'inline-flex min-h-11 items-center justify-center gap-2 px-3 text-sm text-muted-foreground',
  'hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
  FOCUS
);

export const fieldClass = cn(
  'w-full border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground',
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:opacity-50'
);

const MENU_ROW =
  'min-h-11 rounded-none border-b border-border pr-3 pl-8 text-sm last:border-b-0 focus:bg-primary focus:text-primary-foreground';

/** Compact dropdown for an enum value (design system dropdown; no native select). */
export function CompactSelect<T extends string>({
  label,
  value,
  options,
  renderValue,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly T[];
  renderValue: (value: T) => string;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`${label}: ${renderValue(value)}`}
          className={cn(
            'inline-flex h-8 min-w-0 items-center justify-between gap-1.5 border border-border bg-transparent px-2 text-xs text-foreground',
            'hover:border-foreground data-[state=open]:border-foreground data-[state=open]:bg-primary data-[state=open]:text-primary-foreground',
            'disabled:opacity-40',
            FOCUS
          )}
        >
          <span className="truncate">{renderValue(value)}</span>
          <ChevronDown aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44 rounded-none border-foreground p-0">
        <p className="border-b border-foreground px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {label}
        </p>
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            className={MENU_ROW}
            checked={option === value}
            onSelect={() => onChange(option)}
          >
            {renderValue(option)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Square checkbox: a real checkbox input, 44px hit area, ink fill and tick when on (state is not colour only). */
export function IncludeCheckbox({
  checked,
  onChange,
  label,
  indeterminate = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  indeterminate?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="group relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
        className="peer absolute inset-0 m-0 cursor-pointer opacity-0"
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none flex h-4 w-4 items-center justify-center border border-foreground font-mono text-[11px] leading-none',
          (checked || indeterminate) && 'bg-primary text-primary-foreground',
          'group-hover:outline group-hover:outline-1 group-hover:outline-foreground',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring'
        )}
      >
        {indeterminate ? '–' : checked ? '✓' : ''}
      </span>
    </label>
  );
}

/** Switch as a button (design system: segmented/switch controls are buttons). */
export function ToggleRow({
  checked,
  onChange,
  label,
  hint,
  stateLabels,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: ReactNode;
  /** Words for on / off, shown next to the label */
  stateLabels: [string, string];
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('flex min-h-11 items-center gap-3 px-1 text-left disabled:opacity-40', FOCUS)}
    >
      <span
        aria-hidden
        className={cn('relative h-5 w-9 shrink-0 border border-foreground', checked ? 'bg-primary' : 'bg-transparent')}
      >
        <span
          className={cn(
            'absolute top-[3px] h-3 w-3 transition-[left] duration-150 motion-reduce:transition-none',
            checked ? 'left-[19px] bg-primary-foreground' : 'left-[3px] bg-foreground'
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">
          {label}
          <span className="ml-2 font-mono text-[11px] uppercase text-muted-foreground">{checked ? stateLabels[0] : stateLabels[1]}</span>
        </span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </button>
  );
}

/** Inline error with a retry action: signal-text left mark and words, never colour alone. */
export function InlineError({ title, message, onRetry, retryLabel }: { title: string; message?: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border border-destructive border-l-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-destructive">{title}</p>
        {message && <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">{message}</p>}
      </div>
      {onRetry && retryLabel && (
        <button type="button" onClick={onRetry} className={secondaryButton}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}
