/**
 * Building blocks shared by the GitHub Issues / PRs and GitLab Issues / MRs pages, so they look alike
 * (design system: hairlines, radius 0, mono for data, small caps mono for labels):
 * a page header (title, repo in mono, actions on the right), a toolbar (search + filters),
 * list rows with a thin left bar for the selection (as in Deploy's runs), and the detail's labels.
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function IntegrationPageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3.5 border-b border-border px-6 py-[18px]">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {subtitle && <div className="truncate font-mono text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      <span className="flex-1" />
      {children && <div className="flex flex-wrap items-center gap-3.5">{children}</div>}
    </div>
  );
}

export function IntegrationToolbar({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-6 py-3">{children}</div>;
}

/** A count or similar figure in the header, as plain mono text. */
export function HeaderFigure({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs font-medium text-muted-foreground">{children}</span>;
}

/** Classes of a list row: hairline below, a 3px left bar when selected. */
export function listRowClass(selected: boolean): string {
  return cn(
    'group w-full border-b border-l-[3px] border-b-border px-6 py-3 text-left transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
    selected ? 'border-l-foreground bg-card' : 'border-l-transparent hover:bg-muted'
  );
}

/** `#4 · author · date`: the parts that exist, joined, in mono. */
export function MetaLine({ parts, className }: { parts: Array<string | null | undefined | false>; className?: string }) {
  return (
    <span className={cn('block truncate font-mono text-xs text-muted-foreground', className)}>
      {parts.filter(Boolean).join(' · ')}
    </span>
  );
}

/** Small caps mono: a state ("OPEN") or a section label ("DESCRIPTION"). */
export function SmallCaps({ children, as: Tag = 'span', className }: { children: ReactNode; as?: 'span' | 'h3' | 'div'; className?: string }) {
  return (
    <Tag className={cn('font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground', className)}>{children}</Tag>
  );
}
