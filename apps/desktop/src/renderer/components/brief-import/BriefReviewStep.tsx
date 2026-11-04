/**
 * Step 3: review the proposal. Tasks grouped by epic on the left; open
 * questions (needs attention), assumptions and the start order on the right.
 * Editing state lives in the dialog; this component only renders and reports.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BriefProposal, BriefTaskDraft } from '../../../shared/types';
import { MonoTag, Notice, SectionHeader } from '../task-detail/workspace/workspace-ui';
import { buildCreatePayload, computeWaves, dependentsOf, groupByEpic, lostDependencies } from './brief-review-model';
import { IncludeCheckbox } from './brief-ui';
import { BriefTaskRow } from './BriefTaskRow';

export function BriefReviewStep({
  proposal,
  tasks,
  excluded,
  expanded,
  onInclude,
  onIncludeMany,
  onToggleExpanded,
  onChangeTask,
}: {
  proposal: BriefProposal;
  tasks: BriefTaskDraft[];
  excluded: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onInclude: (key: string, include: boolean) => void;
  onIncludeMany: (keys: string[], include: boolean) => void;
  onToggleExpanded: (key: string) => void;
  onChangeTask: (key: string, patch: Partial<BriefTaskDraft>) => void;
}) {
  const { t } = useTranslation(['tasks']);
  const groups = useMemo(() => groupByEpic(proposal.epics, tasks), [proposal.epics, tasks]);
  const lost = useMemo(() => lostDependencies(tasks, excluded), [tasks, excluded]);
  const payload = useMemo(() => buildCreatePayload(tasks, excluded), [tasks, excluded]);
  const { waves, cyclic } = useMemo(() => computeWaves(payload), [payload]);
  const titleOf = useMemo(() => new Map(tasks.map((task) => [task.key, task.title])), [tasks]);
  const includedCount = payload.length;

  return (
    <div className="grid gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* Proposal + tasks */}
      <div className="min-w-0 space-y-8">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <MonoTag>{proposal.briefId}</MonoTag>
            <span className="font-mono text-xs text-muted-foreground">
              {t('tasks:briefImport.review.counts', { tasks: tasks.length, epics: proposal.epics.length })}
            </span>
          </div>
          <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-foreground">{proposal.title}</h3>
          {proposal.summary && <p className="max-w-prose text-[15px] leading-relaxed text-muted-foreground">{proposal.summary}</p>}
        </header>

        {groups.map(({ epic, tasks: groupTasks }) => {
          const keys = groupTasks.map((task) => task.key);
          const inCount = keys.filter((k) => !excluded.has(k)).length;
          const title = epic ? epic.title : t('tasks:briefImport.review.noEpic');
          return (
            <section key={epic?.key ?? '__none'} aria-label={title}>
              <div className="flex min-h-11 items-end gap-2 border-b border-foreground pb-1">
                <IncludeCheckbox
                  checked={inCount === keys.length}
                  indeterminate={inCount > 0 && inCount < keys.length}
                  onChange={() => onIncludeMany(keys, inCount < keys.length)}
                  label={t('tasks:briefImport.review.includeEpic', { title })}
                />
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5 pb-2">
                  {epic && <span className="font-mono text-xs text-muted-foreground">{epic.key}</span>}
                  <h4 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-foreground">{title}</h4>
                  {epic?.summary && <span className="truncate text-xs text-muted-foreground">{epic.summary}</span>}
                </div>
                <span className="pb-2 font-mono text-xs tabular-nums text-muted-foreground">
                  {t('tasks:briefImport.review.included', { included: inCount, total: keys.length })}
                </span>
              </div>
              <ul>
                {groupTasks.map((task) => (
                  <BriefTaskRow
                    key={task.key}
                    task={task}
                    included={!excluded.has(task.key)}
                    expanded={expanded.has(task.key)}
                    lost={lost.get(task.key) ?? []}
                    dependents={excluded.has(task.key) ? dependentsOf(tasks, task.key, excluded) : []}
                    onInclude={(include) => onInclude(task.key, include)}
                    onToggleExpanded={() => onToggleExpanded(task.key)}
                    onChange={(patch) => onChangeTask(task.key, patch)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {/* Questions, assumptions, order */}
      <aside className="min-w-0 space-y-8">
        {proposal.openQuestions.length > 0 && (
          <section aria-labelledby="brief-questions">
            <div className="border-l-2 border-[var(--vt-signal)] bg-muted px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-destructive">
                {t('tasks:briefImport.review.needsAttention')}
              </p>
              <h3 id="brief-questions" className="mt-0.5 text-sm font-semibold text-foreground">
                {t('tasks:briefImport.review.openQuestions', { count: proposal.openQuestions.length })}
              </h3>
              <ol className="mt-2 space-y-2">
                {proposal.openQuestions.map((q, i) => (
                  <li key={q} className="flex gap-2 text-sm text-foreground">
                    <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">Q{i + 1}</span>
                    <span>{q}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-muted-foreground">{t('tasks:briefImport.review.questionsNote')}</p>
            </div>
          </section>
        )}

        {(proposal.clarifications?.length ?? 0) > 0 && (
          <section aria-labelledby="brief-clarifications" className="space-y-3">
            <SectionHeader id="brief-clarifications" title={t('tasks:briefImport.review.clarifications')} meta={proposal.clarifications?.length ?? 0} />
            <ol className="space-y-3">
              {proposal.clarifications?.map((c, i) => (
                <li key={`${i}-${c.question}`} className="text-sm">
                  <p className="text-muted-foreground">{c.question}</p>
                  <p className="mt-0.5 border-l-2 border-foreground pl-3 text-foreground">{c.answer ?? t('tasks:briefImport.question.skipped')}</p>
                </li>
              ))}
            </ol>
          </section>
        )}

        {proposal.assumptions.length > 0 && (
          <section aria-labelledby="brief-assumptions" className="space-y-3">
            <SectionHeader id="brief-assumptions" title={t('tasks:briefImport.review.assumptions')} meta={proposal.assumptions.length} />
            <ul className="space-y-2">
              {proposal.assumptions.map((a) => (
                <li key={a} className="border-l-2 border-foreground pl-3 text-sm text-foreground">
                  {a}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="brief-order" className="space-y-3">
          <SectionHeader id="brief-order" title={t('tasks:briefImport.review.order')} meta={t('tasks:briefImport.review.waveCount', { count: waves.length })} />
          {includedCount === 0 ? (
            <Notice>{t('tasks:briefImport.review.nothingSelected')}</Notice>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t('tasks:briefImport.review.orderHint')}</p>
              <ol className="border border-foreground" data-testid="brief-waves">
                {waves.map((wave, i) => (
                  <li key={wave.join(',')} className="border-b border-border px-3 py-2.5 last:border-b-0">
                    <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
                      {t('tasks:briefImport.review.wave', { index: i + 1 })}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {wave.map((key) => (
                        <li key={key} className="flex min-w-0 gap-2 text-sm">
                          <span className="w-8 shrink-0 font-mono text-xs leading-5 text-foreground">{key}</span>
                          <span className="truncate text-muted-foreground">{titleOf.get(key)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
              {cyclic.length > 0 && (
                <p role="alert" className="border-l-2 border-[var(--vt-signal)] pl-3 text-sm text-foreground">
                  <span className="font-semibold text-destructive">{t('tasks:briefImport.review.cycleTitle')}</span>{' '}
                  {t('tasks:briefImport.review.cycleBody', { keys: cyclic.join(', ') })}
                </p>
              )}
            </>
          )}
        </section>
      </aside>
    </div>
  );
}
