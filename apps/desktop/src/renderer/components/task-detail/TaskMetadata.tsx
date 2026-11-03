/**
 * The task as the user wrote it: description (markdown, collapsible when long)
 * and the context fields that came with it (rationale, dependencies, ...).
 * Classification and dates live in the Overview facts panel.
 */

import { useState, useRef, useLayoutEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import { JSON_ERROR_PREFIX } from '../../../shared/constants';
import type { Task } from '../../../shared/types';
import { MonoTag, SectionHeader, WorkspaceMarkdown } from './workspace/workspace-ui';

interface TaskMetadataProps {
  task: Task;
}

// Height threshold for collapsing long descriptions (~10 lines)
const COLLAPSED_HEIGHT = 240;

function Detail({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border py-3 last:border-b-0">
      <h4 className="text-xs text-muted-foreground">{title}</h4>
      <div className="mt-1 text-sm text-foreground">{children}</div>
    </div>
  );
}

export function TaskMetadata({ task }: TaskMetadataProps) {
  const { t } = useTranslation(['tasks', 'errors']);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();

  const displayDescription = (() => {
    if (!task.description) return null;
    if (task.description.startsWith(JSON_ERROR_PREFIX)) {
      const errorMessage = task.description.slice(JSON_ERROR_PREFIX.length);
      return t('errors:task.jsonError.description', { error: errorMessage });
    }
    return task.description;
  })();

  // Re-measure when the description changes; reset expansion when switching tasks
  // biome-ignore lint/correctness/useExhaustiveDependencies: task.description triggers re-render which changes content height
  useLayoutEffect(() => {
    setIsExpanded(false);
    const element = contentRef.current;
    if (element) {
      setHasOverflow(element.scrollHeight > COLLAPSED_HEIGHT);
    }
  }, [task.id, task.description]);

  const m = task.metadata;
  const hasDetails =
    !!m &&
    (!!m.rationale ||
      !!m.problemSolved ||
      !!m.targetAudience ||
      (m.dependencies?.length ?? 0) > 0 ||
      (m.acceptanceCriteria?.length ?? 0) > 0 ||
      (m.affectedFiles?.length ?? 0) > 0);

  return (
    <div className="space-y-8">
      <section aria-labelledby={`${contentId}-title`}>
        <SectionHeader id={`${contentId}-title`} title={t('tasks:overview.description.title')} />
        {displayDescription ? (
          <div className="mt-3">
            <div className="relative">
              <div
                ref={contentRef}
                id={contentId}
                className={cn('overflow-hidden', !isExpanded && hasOverflow && 'max-h-[240px]')}
              >
                <WorkspaceMarkdown markdown={displayDescription} className="[&_img]:h-auto [&_img]:max-w-full" />
              </div>
              {!isExpanded && hasOverflow && (
                <div aria-hidden className="pointer-events-none absolute right-0 bottom-0 left-0 h-14 bg-gradient-to-t from-card to-transparent" />
              )}
            </div>
            {hasOverflow && (
              <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                aria-expanded={isExpanded}
                aria-controls={contentId}
                className="mt-1 inline-flex h-11 items-center gap-1.5 text-sm font-medium text-foreground underline-offset-2 hover:underline"
              >
                {isExpanded ? <ChevronUp aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}
                {isExpanded ? t('tasks:metadata.showLess') : t('tasks:metadata.showMore')}
              </button>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">{t('tasks:overview.description.empty')}</p>
        )}
      </section>

      {hasDetails && m && (
        <section aria-labelledby={`${contentId}-context`}>
          <SectionHeader id={`${contentId}-context`} title={t('tasks:overview.context.title')} />
          <div>
            {m.rationale && <Detail title={t('tasks:overview.context.rationale')}>{m.rationale}</Detail>}
            {m.problemSolved && <Detail title={t('tasks:overview.context.problemSolved')}>{m.problemSolved}</Detail>}
            {m.targetAudience && <Detail title={t('tasks:overview.context.targetAudience')}>{m.targetAudience}</Detail>}
            {m.dependencies && m.dependencies.length > 0 && (
              <Detail title={t('tasks:overview.context.dependencies')}>
                <ul className="list-inside list-disc space-y-0.5">
                  {m.dependencies.map((dep) => (
                    <li key={dep}>{dep}</li>
                  ))}
                </ul>
              </Detail>
            )}
            {m.acceptanceCriteria && m.acceptanceCriteria.length > 0 && (
              <Detail title={t('tasks:overview.context.acceptanceCriteria')}>
                <ul className="list-inside list-disc space-y-0.5">
                  {m.acceptanceCriteria.map((criteria) => (
                    <li key={criteria}>{criteria}</li>
                  ))}
                </ul>
              </Detail>
            )}
            {m.affectedFiles && m.affectedFiles.length > 0 && (
              <Detail title={t('tasks:overview.context.affectedFiles')}>
                <div className="flex flex-wrap gap-1">
                  {m.affectedFiles.map((file) => (
                    <Tooltip key={file}>
                      <TooltipTrigger asChild>
                        <button type="button" className="cursor-help">
                          <MonoTag>{file.split('/').pop()}</MonoTag>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="font-mono text-xs">
                        {file}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </Detail>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
