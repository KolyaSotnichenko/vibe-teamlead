import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ExternalLink } from 'lucide-react';
import type { TaskWorkspace, WorkspaceAdr, WorkspaceDiagram } from '../../../../shared/types';
import { useToast } from '../../../hooks/use-toast';
import { cn } from '../../../lib/utils';
import { EmptyState, SectionHeader, WorkspaceMarkdown } from './workspace-ui';

const MermaidDiagram = lazy(() => import('./MermaidDiagram'));

interface ArchitectureTabProps {
  workspace: TaskWorkspace;
  taskId: string;
  projectId: string;
}

export function ArchitectureTab({ workspace, taskId, projectId }: ArchitectureTabProps) {
  const { t } = useTranslation(['tasks']);
  const { markdown, adrs, diagrams } = workspace.architecture;

  if (markdown === undefined && adrs.length === 0 && diagrams.length === 0) {
    return <EmptyState title={t('tasks:workspace.architecture.emptyTitle')} body={t('tasks:workspace.architecture.emptyBody')} />;
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="ws-diagrams" className="space-y-3">
        <SectionHeader id="ws-diagrams" title={t('tasks:workspace.architecture.diagramsTitle')} meta={diagrams.length > 0 ? String(diagrams.length) : undefined} />
        {diagrams.length === 0 ? (
          <EmptyState compact title={t('tasks:workspace.architecture.diagramsTitle')} body={t('tasks:workspace.architecture.noDiagrams')} />
        ) : (
          <div className="flex flex-col gap-8">
            {diagrams.map((d) => (
              <DiagramCard key={d.drawioPath ?? `${d.kind}:${d.name}:${d.mermaidSource?.length ?? 0}`} diagram={d} taskId={taskId} projectId={projectId} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="ws-adrs" className="space-y-3">
        <SectionHeader id="ws-adrs" title={t('tasks:workspace.architecture.adrsTitle')} meta={adrs.length > 0 ? String(adrs.length) : undefined} />
        {adrs.length === 0 ? (
          <EmptyState compact title={t('tasks:workspace.architecture.adrsTitle')} body={t('tasks:workspace.architecture.noAdrs')} />
        ) : (
          <ul className="border border-foreground">
            {adrs.map((adr) => (
              <AdrRow key={adr.fileName} adr={adr} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ws-arch-doc" className="space-y-3">
        <SectionHeader id="ws-arch-doc" title={t('tasks:workspace.architecture.documentTitle')} />
        {markdown === undefined ? (
          <EmptyState compact title={t('tasks:workspace.architecture.noDocTitle')} body={t('tasks:workspace.architecture.noDocBody')} />
        ) : (
          <WorkspaceMarkdown markdown={markdown} assets={{ taskId, projectId, baseDir: 'architecture' }} />
        )}
      </section>
    </div>
  );
}

function AdrRow({ adr }: { adr: WorkspaceAdr }) {
  const { t } = useTranslation(['tasks']);
  const [open, setOpen] = useState(false);
  const number = /^(\d+)/.exec(adr.fileName)?.[1];
  const superseded = adr.status?.startsWith('superseded') || adr.status?.startsWith('deprecated');

  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${adr.title}. ${open ? t('tasks:workspace.architecture.collapseAdr') : t('tasks:workspace.architecture.expandAdr')}`}
        className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        {number && <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">{number}</span>}
        <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', superseded ? 'text-muted-foreground line-through' : 'text-foreground')}>
          {adr.title}
        </span>
        <span
          className={cn(
            'inline-flex h-6 shrink-0 items-center px-2 font-mono text-[11px] uppercase tracking-[0.04em]',
            adr.status === 'accepted' ? 'border border-foreground text-foreground' : 'bg-accent text-muted-foreground'
          )}
        >
          {adr.status ?? t('tasks:workspace.architecture.adrStatusUnknown')}
        </span>
      </button>
      {open && (
        <div className="border-t border-border bg-background px-6 py-4">
          <WorkspaceMarkdown markdown={adr.markdown} />
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">architecture/adr/{adr.fileName}</p>
        </div>
      )}
    </li>
  );
}

/** Fetched diagram previews, keyed by task, path and version (re-fetched only when re-rendered). */
const imageCache = new Map<string, string>();

function useDiagramImage(taskId: string, projectId: string, pngPath?: string, version?: number): string | undefined {
  const key = pngPath ? `${taskId}:${pngPath}@${version ?? 0}` : '';
  const [src, setSrc] = useState(() => (key ? imageCache.get(key) : undefined));
  useEffect(() => {
    if (!key || !pngPath) return;
    const cached = imageCache.get(key);
    if (cached) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    window.electronAPI.getTaskWorkspaceImage(taskId, pngPath, projectId).then((result) => {
      if (cancelled || !result.success || !result.data) return;
      imageCache.set(key, result.data);
      setSrc(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [key, pngPath, taskId, projectId]);
  return src;
}

function DiagramCard({ diagram, taskId, projectId }: { diagram: WorkspaceDiagram; taskId: string; projectId: string }) {
  const { t } = useTranslation(['tasks']);
  const { toast } = useToast();
  const image = useDiagramImage(taskId, projectId, diagram.pngPath, diagram.pngVersion);

  const openDrawio = async () => {
    if (!diagram.drawioPath) return;
    const result = await window.electronAPI.openTaskWorkspaceFile(taskId, diagram.drawioPath, projectId);
    if (!result.success) {
      toast({ title: t('tasks:workspace.architecture.openFailed'), description: result.error, variant: 'destructive' });
    }
  };

  return (
    <figure className="mx-0 mb-0 space-y-2">
      <figcaption className="flex min-h-11 items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{diagram.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{diagram.kind === 'drawio' ? '.drawio' : '.mmd'}</span>
        </div>
        {diagram.kind === 'drawio' && diagram.drawioPath && (
          <button
            type="button"
            onClick={openDrawio}
            className="inline-flex h-11 shrink-0 items-center gap-2 border border-foreground px-4 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
            {t('tasks:workspace.architecture.openInDrawio')}
          </button>
        )}
      </figcaption>

      {diagram.kind === 'drawio' ? (
        image ? (
          // draw.io PNGs are drawn on white; keep them on a paper panel in both themes
          <div className="overflow-auto border border-border bg-[var(--vt-paper)] p-4">
            <img src={image} alt={diagram.name} className="mx-auto h-auto max-w-full" />
          </div>
        ) : diagram.pngPath ? (
          <div role="status" className="border border-border px-4 py-6 text-sm text-muted-foreground">
            {t('tasks:workspace.loading')}
          </div>
        ) : (
          <div className="border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            <p>{t('tasks:workspace.architecture.noPreview')}</p>
            <p className="mt-1 font-mono text-[11px]">{diagram.drawioPath}</p>
          </div>
        )
      ) : diagram.mermaidSource ? (
        <Suspense
          fallback={
            <div role="status" className="border border-border px-4 py-6 text-sm text-muted-foreground">
              {t('tasks:workspace.architecture.mermaidLoading')}
            </div>
          }
        >
          <MermaidDiagram source={diagram.mermaidSource} label={diagram.name} />
        </Suspense>
      ) : null}
    </figure>
  );
}
