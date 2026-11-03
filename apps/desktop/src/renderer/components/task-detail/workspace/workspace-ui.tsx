/**
 * Small presentational pieces shared by the workspace tabs.
 * Design system: radius 0, no shadows, hairlines, vermilion only for "needs attention",
 * IBM Plex Mono for data (ids, paths, times).
 */

import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
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

/**
 * Where relative image paths in a spec-dir markdown file point: the task, and the
 * file's folder relative to the spec dir (e.g. "architecture" for architecture.md).
 */
export interface MarkdownAssets {
  taskId: string;
  projectId: string;
  baseDir: string;
}

const isRelativePath = (href: string | undefined): href is string =>
  !!href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && !href.startsWith('/');

/** `baseDir` + a relative path, normalised ("./", "../"), without query or hash. Pure — tested directly. */
export function joinSpecPath(baseDir: string, relative: string): string {
  const parts: string[] = [];
  for (const seg of `${baseDir}/${relative.split(/[?#]/)[0]}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(decodeURIComponent(seg));
  }
  return parts.join('/');
}

/** The PNG to show for a diagram reference: the PNG itself, or the PNG render_diagram saves next to a .drawio/.mmd. */
export function diagramImagePath(specPath: string): string | null {
  if (/\.png$/i.test(specPath)) return specPath;
  if (/\.(drawio|mmd)$/i.test(specPath)) return specPath.replace(/\.(drawio|mmd)$/i, '.png');
  return null;
}

const specImageCache = new Map<string, string>();

/** A PNG from the task's spec folder (the renderer can't read files by path). */
function SpecImage({ assets, path, alt }: { assets: MarkdownAssets; path: string; alt: string }) {
  const key = `${assets.taskId}:${path}`;
  const [src, setSrc] = useState(() => specImageCache.get(key));
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const cached = specImageCache.get(key);
    if (cached) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    window.electronAPI
      ?.getTaskWorkspaceImage?.(assets.taskId, path, assets.projectId)
      .then((result) => {
        if (cancelled) return;
        if (result?.success && result.data) {
          specImageCache.set(key, result.data);
          setSrc(result.data);
        } else setMissing(true);
      })
      .catch(() => !cancelled && setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [key, path, assets.taskId, assets.projectId]);
  if (missing) return <span className="font-mono text-xs text-muted-foreground">{path}</span>;
  if (!src) return <span className="block h-24 border border-dashed border-border" aria-busy="true" />;
  return (
    <span className="not-prose my-4 block border border-border bg-white p-3">
      <img src={src} alt={alt} className="mx-auto h-auto max-w-full" />
    </span>
  );
}

function createMarkdownComponents(assets?: MarkdownAssets): Components {
  if (!assets) return markdownComponents;
  return {
    ...markdownComponents,
    img({ src, alt, node: _node, ...props }) {
      const source = typeof src === 'string' ? src : undefined;
      const image = isRelativePath(source) ? diagramImagePath(joinSpecPath(assets.baseDir, source)) : null;
      if (image) return <SpecImage assets={assets} path={image} alt={alt ?? ''} />;
      return <img src={source} alt={alt} {...props} />;
    },
    a({ href, children, node, ...props }) {
      // "link diagrams/context.png" in agent docs: show the diagram itself
      const image = isRelativePath(href) ? diagramImagePath(joinSpecPath(assets.baseDir, href)) : null;
      if (image) return <SpecImage assets={assets} path={image} alt={typeof children === 'string' ? children : image} />;
      void node;
      return (
        <a {...props} href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    },
  };
}

const markdownComponents: Components = {
  // Links in agent-written markdown open in the browser, never inside the app window.
  a({ href, children, node: _node, ...props }) {
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  code({ className, children, ...props }) {
    const language = /language-(\w+)/.exec(className ?? '')?.[1];
    if (language === 'mermaid') {
      return (
        <div className="not-prose my-5">
          <Suspense fallback={null}>
            <MermaidDiagram source={String(children).replace(/\n$/, '')} />
          </Suspense>
        </div>
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
export function WorkspaceMarkdown({ markdown, className, assets }: { markdown: string; className?: string; assets?: MarkdownAssets }) {
  const components = useMemo(() => createMarkdownComponents(assets), [assets?.taskId, assets?.projectId, assets?.baseDir]);
  return (
    <div className={cn(PROSE, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
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
