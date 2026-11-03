import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskWorkspace, WorkspaceAcceptanceCriterion, WorkspacePlanSubtask } from '../../../../shared/types';
import { cn } from '../../../lib/utils';
import { AcStatusChip, EmptyState, Notice, SectionHeader, SubtaskStatusLabel, WorkspaceMarkdown } from './workspace-ui';

interface SpecTabProps {
  workspace: TaskWorkspace;
  onOpenSubtask: (subtaskId: string) => void;
}

export function SpecTab({ workspace, onOpenSubtask }: SpecTabProps) {
  const { t } = useTranslation(['tasks']);
  const spec = workspace.spec;

  const subtasksById = useMemo(() => {
    const map = new Map<string, WorkspacePlanSubtask>();
    for (const phase of workspace.plan?.phases ?? []) for (const s of phase.subtasks) map.set(s.id, s);
    return map;
  }, [workspace.plan]);

  if (!spec) {
    return <EmptyState title={t('tasks:workspace.spec.emptyTitle')} body={t('tasks:workspace.spec.emptyBody')} />;
  }

  const counts = { pass: 0, fail: 0, untested: 0 };
  for (const c of spec.criteria) counts[c.status]++;

  return (
    <div className="space-y-8">
      <section aria-labelledby="ws-ac-title" className="space-y-3">
        <SectionHeader
          id="ws-ac-title"
          title={t('tasks:workspace.spec.criteriaTitle')}
          meta={spec.criteria.length > 0 ? t('tasks:workspace.spec.criteriaSummary', counts) : undefined}
        />
        {spec.criteria.length === 0 ? (
          <EmptyState compact title={t('tasks:workspace.spec.noCriteriaTitle')} body={t('tasks:workspace.spec.noCriteriaBody')} />
        ) : (
          <>
            {!workspace.hasQaCoverage && <Notice>{t('tasks:workspace.spec.noQa')}</Notice>}
            <ul className="border border-foreground">
              {spec.criteria.map((criterion) => (
                <CriterionRow key={criterion.id} criterion={criterion} subtasksById={subtasksById} onOpenSubtask={onOpenSubtask} />
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="ws-spec-doc" className="space-y-3">
        <SectionHeader id="ws-spec-doc" title={t('tasks:workspace.spec.documentTitle')} />
        <WorkspaceMarkdown markdown={spec.markdown} />
      </section>
    </div>
  );
}

function CriterionRow({
  criterion,
  subtasksById,
  onOpenSubtask,
}: {
  criterion: WorkspaceAcceptanceCriterion;
  subtasksById: Map<string, WorkspacePlanSubtask>;
  onOpenSubtask: (id: string) => void;
}) {
  const { t } = useTranslation(['tasks']);
  const failed = criterion.status === 'fail';

  return (
    <li
      className={cn(
        'grid grid-cols-[64px_minmax(0,1fr)_auto] gap-x-4 border-b border-border px-4 py-3 last:border-b-0',
        failed && 'border-l-2 border-l-destructive pl-[14px]'
      )}
    >
      <span className="pt-0.5 font-mono text-[13px] font-semibold text-foreground">{criterion.id}</span>

      <div className="min-w-0 space-y-2">
        <p className="text-sm leading-relaxed text-foreground">
          <InlineCode text={criterion.text} />
          {criterion.testLevel && (
            <span className="ml-2 inline-flex h-5 items-center border border-border px-1.5 align-[1px] font-mono text-[11px] text-muted-foreground">
              {t(`tasks:workspace.spec.testLevel.${criterion.testLevel}`)}
            </span>
          )}
        </p>

        {criterion.tests.length > 0 && (
          <ul className="space-y-0.5">
            {criterion.tests.map((test) => {
              const notAsserting = /^no\b/i.test(test.asserts);
              return (
                <li key={`${test.test}-${test.result}`} className="flex flex-wrap items-baseline gap-x-2 font-mono text-[12px]">
                  <span className={cn(test.result === 'fail' ? 'text-destructive' : 'text-muted-foreground')}>
                    {test.result === 'pass' ? '✓' : test.result === 'fail' ? '✕' : '·'}
                  </span>
                  <span className="break-all text-foreground">{test.test || '—'}</span>
                  {notAsserting && <span className="font-sans text-destructive">{t('tasks:workspace.spec.doesNotAssert')}</span>}
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-xs text-muted-foreground">{t('tasks:workspace.spec.coveredBy')}</span>
          {criterion.coveredBy.length === 0 ? (
            <span className={cn('text-xs', subtasksById.size > 0 ? 'text-destructive' : 'text-muted-foreground')}>
              {t('tasks:workspace.spec.notCovered')}
            </span>
          ) : (
            criterion.coveredBy.map((id) => {
              const subtask = subtasksById.get(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onOpenSubtask(id)}
                  className="inline-flex min-h-8 max-w-full items-center gap-2 border border-border bg-card px-2 text-left text-xs text-foreground hover:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-mono text-[11px] text-muted-foreground">{id}</span>
                  {subtask && <span className="truncate">{subtask.title}</span>}
                  {subtask && <SubtaskStatusLabel status={subtask.status} />}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="pt-0.5">
        <AcStatusChip status={criterion.status} />
      </div>
    </li>
  );
}

/** Render `code` spans in criterion text without a full markdown pass. */
function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <code key={i} className="font-mono text-[12.5px]">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        )
      )}
    </>
  );
}
