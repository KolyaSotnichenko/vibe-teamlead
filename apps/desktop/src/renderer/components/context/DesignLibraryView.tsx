/**
 * Context → Design system → Screens: the project's design library, the latest version of every
 * wireframe and screen the tasks drew (design before code), on one canvas, each frame with the
 * task it came from; any frame plays as a prototype.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import type { DesignLibrary, TaskDesignFrame } from '../../../shared/types';
import { cn } from '../../lib/utils';
import { EmptyState } from '../task-detail/workspace/workspace-ui';
import { DesignCanvas, PrototypeDialog } from '../task-detail/design/DesignCanvas';
import { type FrameFilter, visibleFrames } from '../task-detail/design/design-canvas';

export function libraryUrl(projectId: string, file: string, mock?: Record<string, string>): string {
  if (mock?.[file]) return mock[file];
  return `vt-design://project/${encodeURIComponent(projectId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export function DesignLibraryView({ projectId }: { projectId: string }) {
  const { t } = useTranslation(['common', 'tasks']);
  const [library, setLibrary] = useState<DesignLibrary | null>(null);
  const [filter, setFilter] = useState<FrameFilter>('screens');
  const [prototype, setPrototype] = useState<{ frame: TaskDesignFrame; width: number } | null>(null);

  useEffect(() => {
    let live = true;
    void window.electronAPI.design.library(projectId).then((result) => live && setLibrary(result.success && result.data ? result.data : { frames: [] }));
    return () => {
      live = false;
    };
  }, [projectId]);

  const hasScreens = !!library?.frames.some((f) => f.kind === 'screen');
  const hasWireframes = !!library?.frames.some((f) => f.kind === 'wireframe');
  const shown: FrameFilter = !hasScreens ? 'wireframes' : !hasWireframes ? 'screens' : filter;
  const frames = useMemo(
    () => (library ? visibleFrames(library.frames, shown).map((f) => ({ ...f, title: f.taskTitle ? `${f.title} · ${f.taskTitle}` : f.title })) : []),
    [library, shown],
  );

  if (!library) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!library.frames.length) return <EmptyState title={t('context.design.library.emptyTitle')} body={t('context.design.library.emptyBody')} />;

  const urlFor = (file: string) => libraryUrl(projectId, file, library.frameSrc);
  return (
    <section className="space-y-3" aria-label={t('context.design.tabs.screens')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">{t('context.design.library.body')}</p>
        {hasWireframes && hasScreens && (
          <div role="radiogroup" aria-label={t('tasks:design.show')} className="flex border border-foreground text-xs">
            {(['wireframes', 'screens', 'all'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={shown === f}
                onClick={() => setFilter(f)}
                className={cn('min-h-8 px-2.5', shown === f ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted')}
              >
                {t(`tasks:design.filter.${f}`)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex h-[620px] border border-foreground">
        <DesignCanvas frames={frames} urlFor={urlFor} onPlay={(frame) => setPrototype({ frame, width: frame.width })} />
      </div>
      <PrototypeDialog prototype={prototype} onChange={setPrototype} urlFor={urlFor} />
    </section>
  );
}
