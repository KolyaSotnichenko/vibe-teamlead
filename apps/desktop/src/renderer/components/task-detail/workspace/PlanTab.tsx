/**
 * Plan tab: dependency graph + selected-subtask details + "what happened" timeline.
 * Default export so it can be React.lazy-loaded (pulls in @xyflow/react).
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { TaskWorkspace, WorkspacePlanSubtask } from '../../../../shared/types';
import { PlanGraph } from './PlanGraph';
import { PlanTimeline } from './PlanTimeline';
import { EmptyState, MonoTag, SectionHeader, SubtaskStatusLabel } from './workspace-ui';

interface PlanTabProps {
  workspace: TaskWorkspace;
  selectedSubtaskId: string | null;
  onSelectSubtask: (id: string | null) => void;
}

export default function PlanTab({ workspace, selectedSubtaskId, onSelectSubtask }: PlanTabProps) {
  const { t } = useTranslation(['tasks']);
  const plan = workspace.plan;

  const subtasks = useMemo(() => plan?.phases.flatMap((p) => p.subtasks) ?? [], [plan]);
  const selected = subtasks.find((s) => s.id === selectedSubtaskId) ?? null;
  const done = subtasks.filter((s) => s.status === 'completed').length;

  return (
    <div className="space-y-8">
      <section aria-labelledby="ws-graph-title" className="space-y-3">
        <SectionHeader
          id="ws-graph-title"
          title={t('tasks:workspace.plan.graphTitle')}
          meta={plan ? t('tasks:workspace.plan.graphSummary', { phases: plan.phases.length, subtasks: subtasks.length, done }) : undefined}
        />
        {!plan ? (
          <EmptyState title={t('tasks:workspace.plan.emptyTitle')} body={t('tasks:workspace.plan.emptyBody')} />
        ) : (
          <>
            <Legend />
            <PlanGraph plan={plan} selectedId={selectedSubtaskId} onSelect={onSelectSubtask} />
            {selected ? (
              <SubtaskDetails subtask={selected} all={subtasks} onSelect={onSelectSubtask} />
            ) : (
              <p className="text-xs text-muted-foreground">{t('tasks:workspace.plan.selectHint')}</p>
            )}
          </>
        )}
      </section>

      <PlanTimeline timeline={workspace.timeline} plan={plan} onOpenSubtask={onSelectSubtask} />
    </div>
  );
}

function Legend() {
  const { t } = useTranslation(['tasks']);
  const swatch = 'inline-block h-3 w-5 shrink-0';
  return (
    <ul aria-label={t('tasks:workspace.plan.legend')} className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <li className="flex items-center gap-2">
        <span className={`${swatch} bg-primary`} />
        {t('tasks:workspace.subtaskStatus.completed')}
      </li>
      <li className="flex items-center gap-2">
        <span className={`${swatch} relative border border-foreground bg-card`}>
          <span className="absolute inset-x-0 top-0 h-[2px] bg-foreground" />
        </span>
        {t('tasks:workspace.subtaskStatus.in_progress')}
      </li>
      <li className="flex items-center gap-2">
        <span className={`${swatch} border border-dashed border-muted-foreground/60 bg-background`} />
        {t('tasks:workspace.subtaskStatus.pending')}
      </li>
      <li className="flex items-center gap-2">
        <span className={`${swatch} border border-border bg-accent`} />
        {t('tasks:workspace.subtaskStatus.blocked')}
      </li>
      <li className="flex items-center gap-2">
        <span className={`${swatch} relative border border-destructive bg-card`}>
          <span className="absolute inset-y-0 left-0 w-[2px] bg-destructive" />
        </span>
        <span className="text-destructive">{t('tasks:workspace.subtaskStatus.failed')}</span>
      </li>
    </ul>
  );
}

function SubtaskDetails({
  subtask,
  all,
  onSelect,
}: {
  subtask: WorkspacePlanSubtask;
  all: WorkspacePlanSubtask[];
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation(['tasks']);
  const byId = new Map(all.map((s) => [s.id, s]));
  const description = subtask.description.replace(/^\s*\[[^\]]*AC-\d+[^\]]*\]\s*/i, '');

  return (
    <div className="border border-foreground bg-card" aria-live="polite">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border pl-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="font-mono text-xs text-muted-foreground">{subtask.id}</span>
          <span className="truncate text-sm font-semibold text-foreground">{subtask.title}</span>
          <SubtaskStatusLabel status={subtask.status} />
        </div>
        <button
          type="button"
          onClick={() => onSelect(null)}
          aria-label={t('tasks:workspace.plan.closeDetails')}
          className="flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <dl className="grid grid-cols-[120px_minmax(0,1fr)] text-sm [&>*:nth-last-child(-n+2)]:border-b-0">
        {description && (
          <>
            <dt className="sr-only">{t('tasks:workspace.plan.description')}</dt>
            <dd className="col-span-2 whitespace-pre-wrap border-b border-border px-4 py-3 text-foreground">{description}</dd>
          </>
        )}
        <DetailRow label={t('tasks:workspace.plan.covers')}>
          {subtask.acIds.length > 0 ? subtask.acIds.map((ac) => <MonoTag key={ac}>{ac}</MonoTag>) : <span className="text-muted-foreground">—</span>}
        </DetailRow>
        <DetailRow label={t('tasks:workspace.plan.dependsOn')}>
          {subtask.dependsOn.length > 0 ? (
            subtask.dependsOn.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onSelect(id)}
                className="inline-flex min-h-8 items-center gap-2 border border-border px-2 text-xs hover:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="font-mono text-[11px] text-muted-foreground">{id}</span>
                <span className="text-foreground">{byId.get(id)?.title}</span>
              </button>
            ))
          ) : (
            <span className="text-muted-foreground">{t('tasks:workspace.plan.noDeps')}</span>
          )}
        </DetailRow>
        {subtask.files.length > 0 && (
          <DetailRow label={t('tasks:workspace.plan.files')}>
            {subtask.files.map((f) => (
              <MonoTag key={f}>{f}</MonoTag>
            ))}
          </DetailRow>
        )}
        {subtask.verification && (
          <DetailRow label={t('tasks:workspace.plan.verification')}>
            <span className="font-mono text-xs text-foreground">
              {subtask.verification.type}
              {subtask.verification.run ? ` · ${subtask.verification.run}` : ''}
            </span>
          </DetailRow>
        )}
      </dl>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center gap-1.5 border-b border-border py-2 pr-4">{children}</dd>
    </>
  );
}
