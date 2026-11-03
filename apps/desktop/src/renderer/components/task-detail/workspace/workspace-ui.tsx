/**
 * Small presentational pieces shared by the workspace tabs.
 * Design system: radius 0, no shadows, hairlines, vermilion only for "needs attention",
 * IBM Plex Mono for data (ids, paths, times).
 */

import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../../lib/utils';
import type { AcStatus, WorkspaceSubtaskStatus } from '../../../../shared/types';

const MermaidDiagram = lazy(() => import('./MermaidDiagram'));

export function SectionHeader({ title, meta, action, id }: { title: string; meta?: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="flex min-h-11 items-end justify-between gap-4 border-b border-foreground pb-2">
      <div className="flex min-w-0 items-baseline gap-3">
        <h3 id={id} className="text-[13px] font-semibold uppercase tracking-[0.06em] text-foreground">
          {title}
        </h3>
        {meta && <span className="truncate font-mono text-xs text-muted-foreground">{meta}</span>}
      </div>
      {action}
    </div>
  );
}

/** Empty state: what will appear here, and when. Hairline frame, no illustration. */
export function EmptyState({ title, body, compact = false }: { title: string; body: string; compact?: boolean }) {
  return (
    <div className={cn('border border-dashed border-border', compact ? 'px-4 py-4' : 'px-6 py-10')}>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

/** Notice row (ink left mark) — neutral information, e.g. "QA has not reported yet". */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="border-l-2 border-foreground bg-muted px-3 py-2 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * AC status chip. Mirrors the design-system severity chips:
 * FAIL = signal fill + paper text (needs attention), PASS = ink outline, UNTESTED = low fill, muted text.
 * The word is always shown, so status never depends on colour alone.
 */
export function AcStatusChip({ status }: { status: AcStatus }) {
  const { t } = useTranslation(['tasks']);
  return (
    <span
      className={cn(
        'inline-flex h-6 min-w-[76px] shrink-0 items-center justify-center gap-1.5 px-2 font-mono text-[11px] font-semibold uppercase tracking-[0.04em]',
        status === 'pass' && 'border border-foreground text-foreground',
        status === 'fail' && 'border border-destructive bg-destructive text-destructive-foreground',
        status === 'untested' && 'border border-transparent bg-accent text-muted-foreground'
      )}
    >
      <span aria-hidden="true">{status === 'pass' ? '✓' : status === 'fail' ? '✕' : '–'}</span>
      {t(`tasks:workspace.acStatus.${status}`)}
    </span>
  );
}

const SUBTASK_GLYPH: Record<WorkspaceSubtaskStatus, string> = {
  completed: '■',
  in_progress: '◧',
  pending: '□',
  blocked: '▨',
  failed: '✕',
};

/** Subtask status: fill + glyph + word. */
export function SubtaskStatusLabel({ status, inverted = false }: { status: WorkspaceSubtaskStatus; inverted?: boolean }) {
  const { t } = useTranslation(['tasks']);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]',
        status === 'failed' ? (inverted ? 'text-destructive-foreground' : 'text-destructive') : inverted ? 'text-primary-foreground' : 'text-muted-foreground'
      )}
    >
      <span aria-hidden="true">{SUBTASK_GLYPH[status]}</span>
      {t(`tasks:workspace.subtaskStatus.${status}`)}
    </span>
  );
}

export function MonoTag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 items-center border border-border px-1.5 font-mono text-[11px] text-foreground', className)}>
      {children}
    </span>
  );
}

const PROSE =
  'prose prose-sm dark:prose-invert max-w-none text-foreground ' +
  'prose-headings:text-foreground prose-headings:tracking-[-0.02em] prose-h1:text-[22px] prose-h1:font-semibold prose-h2:text-[17px] prose-h2:font-semibold prose-h2:mt-7 prose-h2:pb-1 prose-h2:border-b prose-h2:border-border prose-h3:text-[15px] ' +
  'prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-a:text-foreground prose-a:underline-offset-2 ' +
  'prose-code:font-mono prose-code:text-[12.5px] prose-code:font-normal prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none ' +
  'prose-pre:bg-muted prose-pre:text-foreground prose-pre:border prose-pre:border-border prose-pre:rounded-none ' +
  'prose-table:text-[13px] prose-th:border-b prose-th:border-foreground prose-th:text-foreground prose-td:border-b prose-td:border-border prose-hr:border-border ' +
  '[overflow-wrap:anywhere]';

const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const language = /language-(\w+)/.exec(className ?? '')?.[1];
    if (language === 'mermaid') {
      return (
        <Suspense fallback={null}>
          <MermaidDiagram source={String(children).replace(/\n$/, '')} />
        </Suspense>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre({ children, node, ...props }) {
    // A mermaid fence renders as a diagram, not inside a <pre>
    const child = node?.children?.[0];
    const isMermaid =
      child?.type === 'element' &&
      Array.isArray(child.properties?.className) &&
      (child.properties.className as string[]).includes('language-mermaid');
    if (isMermaid) return <>{children}</>;
    return <pre {...props}>{children}</pre>;
  },
};

/** Markdown in the design system's datasheet style; ```mermaid fences render as diagrams. */
export function WorkspaceMarkdown({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div className={cn(PROSE, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/** Format an ISO timestamp as local HH:MM (mono data). */
export function formatClock(iso: string, locale: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(iso: string, locale: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** Elapsed time between two recorded timestamps, e.g. "1h 07m", "42m", "35s". */
export function formatElapsed(startIso: string, endIso: string): string {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
}
