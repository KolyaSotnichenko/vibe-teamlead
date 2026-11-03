/**
 * "What happened" — a vertical timeline built only from recorded timestamps
 * (task_logs.json). No predicted or estimated dates.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspacePlan, WorkspaceTimelineItem } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { EmptyState, SectionHeader, formatClock, formatDay, formatElapsed } from './workspace-ui';

interface PlanTimelineProps {
  timeline: WorkspaceTimelineItem[];
  plan?: WorkspacePlan;
  onOpenSubtask: (id: string) => void;
}

interface PhaseGroup {
  phase: WorkspaceTimelineItem;
  children: WorkspaceTimelineItem[];
}

export function PlanTimeline({ timeline, plan, onOpenSubtask }: PlanTimelineProps) {
  const { t, i18n } = useTranslation(['tasks']);
  const locale = i18n.language;

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const phase of plan?.phases ?? []) for (const s of phase.subtasks) map.set(s.id, s.title);
    return map;
  }, [plan]);

  const groups = useMemo<PhaseGroup[]>(() => {
    const result: PhaseGroup[] = [];
    for (const item of timeline) {
      if (item.kind === 'phase') result.push({ phase: item, children: [] });
    }
    for (const item of timeline) {
      if (item.kind === 'phase') continue;
      result.find((g) => g.phase.phase === item.phase)?.children.push(item);
    }
    return result;
  }, [timeline]);

  return (
    <section aria-labelledby="ws-timeline-title" className="space-y-3">
      <SectionHeader id="ws-timeline-title" title={t('tasks:workspace.timeline.title')} meta={t('tasks:workspace.timeline.subtitle')} />
      {groups.length === 0 ? (
        <EmptyState compact title={t('tasks:workspace.timeline.emptyTitle')} body={t('tasks:workspace.timeline.emptyBody')} />
      ) : (
        <ol className="border border-foreground">
          {groups.map(({ phase, children }, groupIndex) => {
            const prevDay = groupIndex > 0 ? formatDay(groups[groupIndex - 1].phase.startedAt, locale) : '';
            const day = formatDay(phase.startedAt, locale);
            return (
              <li key={phase.id} className="border-b border-border last:border-b-0">
                <TimelineRow item={phase} label={t(`tasks:workspace.timeline.phase.${phase.phase}`)} day={day !== prevDay ? day : undefined} strong />
                {children.length > 0 && (
                  // Continuous hairline rail under the phase marker (marker centre = 16px padding + 8px)
                  <ol className="mb-3 ml-6 border-l border-border">
                    {children.map((child) => {
                      const label =
                        child.kind === 'session'
                          ? t('tasks:workspace.timeline.session', { number: child.session })
                          : titles.get(child.subtaskId ?? '') ?? child.subtaskId ?? '';
                      return (
                        <li key={child.id}>
                          <TimelineRow
                            item={child}
                            label={label}
                            idTag={child.kind === 'subtask' ? child.subtaskId : undefined}
                            onClick={child.kind === 'subtask' && child.subtaskId ? () => onOpenSubtask(child.subtaskId as string) : undefined}
                          />
                        </li>
                      );
                    })}
                  </ol>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function TimelineRow({
  item,
  label,
  day,
  idTag,
  strong = false,
  onClick,
}: {
  item: WorkspaceTimelineItem;
  label: string;
  day?: string;
  idTag?: string;
  strong?: boolean;
  onClick?: () => void;
}) {
  const { t, i18n } = useTranslation(['tasks']);
  const locale = i18n.language;
  const running = item.endedAt === null;
  const failed = item.status === 'failed';

  const content = (
    <>
      {/* Square marker: filled when finished, outlined (breathing) while running, signal when failed */}
      <span
        aria-hidden="true"
        className={cn(
          'mt-[5px] block shrink-0',
          strong ? 'h-2.5 w-2.5' : '-ml-[4.5px] h-2 w-2',
          running ? 'vt-breathe border border-foreground bg-background' : failed ? 'bg-destructive' : 'bg-foreground'
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn('truncate', strong ? 'text-sm font-semibold text-foreground' : 'text-[13px] text-foreground')}>{label}</span>
          {idTag && <span className="font-mono text-[11px] text-muted-foreground">{idTag}</span>}
          {running && <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-foreground">{t('tasks:workspace.timeline.running')}</span>}
          {failed && <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-destructive">{t('tasks:workspace.timeline.failed')}</span>}
        </span>
        {strong && (
          <span className="block text-xs text-muted-foreground">{t('tasks:workspace.timeline.entries', { count: item.entryCount })}</span>
        )}
      </span>
      <span className="shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground">
        {day && <span className="mr-2 text-foreground">{day}</span>}
        <time dateTime={item.startedAt}>{formatClock(item.startedAt, locale)}</time>
        {' – '}
        {item.endedAt ? <time dateTime={item.endedAt}>{formatClock(item.endedAt, locale)}</time> : '…'}
        {item.endedAt && <span className="ml-2 inline-block min-w-[52px] text-foreground">{formatElapsed(item.startedAt, item.endedAt)}</span>}
        {!item.endedAt && <span className="ml-2 inline-block min-w-[52px]" />}
      </span>
    </>
  );

  const rowClass = cn('flex w-full min-h-11 items-start text-left', strong ? 'gap-3 px-[19px] py-2.5' : 'gap-4 py-2 pr-4');

  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(rowClass, 'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring')}
    >
      {content}
    </button>
  ) : (
    <div className={rowClass}>{content}</div>
  );
}
