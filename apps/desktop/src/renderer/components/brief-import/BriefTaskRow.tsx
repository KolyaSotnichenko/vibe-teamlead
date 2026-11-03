/**
 * One proposed task in the review list: include checkbox, key, inline title,
 * complexity / priority / category, dependency chips; expands to the
 * description and the acceptance criteria.
 */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import type { BriefTaskDraft, TaskCategory, TaskComplexity, TaskPriority } from '../../../shared/types';
import { cn } from '../../lib/utils';
import { MonoTag } from '../task-detail/workspace/workspace-ui';
import { CompactSelect, fieldClass, ghostButton, IncludeCheckbox } from './brief-ui';

export const COMPLEXITIES: readonly TaskComplexity[] = ['trivial', 'small', 'medium', 'large', 'complex'];
export const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
export const CATEGORIES: readonly TaskCategory[] = [
  'feature',
  'bug_fix',
  'refactoring',
  'documentation',
  'security',
  'performance',
  'ui_ux',
  'infrastructure',
  'testing',
];

export function BriefTaskRow({
  task,
  included,
  expanded,
  lost,
  dependents,
  onInclude,
  onToggleExpanded,
  onChange,
}: {
  task: BriefTaskDraft;
  included: boolean;
  expanded: boolean;
  /** Dependencies on tasks that are left out (they will be dropped) */
  lost: string[];
  /** Included tasks that depend on this one (shown when this one is left out) */
  dependents: string[];
  onInclude: (include: boolean) => void;
  onToggleExpanded: () => void;
  onChange: (patch: Partial<BriefTaskDraft>) => void;
}) {
  const { t } = useTranslation(['tasks']);
  const detailsId = useId();
  const titleEmpty = included && task.title.trim().length === 0;
  const v = (group: 'complexity' | 'priority' | 'category', value: string) => t(`tasks:overview.values.${group}.${value}`);

  const setCriterion = (index: number, value: string) =>
    onChange({ acceptanceCriteria: task.acceptanceCriteria.map((ac, i) => (i === index ? value : ac)) });
  const removeCriterion = (index: number) =>
    onChange({ acceptanceCriteria: task.acceptanceCriteria.filter((_, i) => i !== index) });
  const addCriterion = () => onChange({ acceptanceCriteria: [...task.acceptanceCriteria, ''] });

  return (
    <li
      data-testid={`brief-task-${task.key}`}
      data-included={included || undefined}
      className={cn('border-b border-border last:border-b-0', !included && 'bg-muted')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 pr-1">
        <IncludeCheckbox
          checked={included}
          onChange={onInclude}
          label={t('tasks:briefImport.review.includeTask', { key: task.key, title: task.title || task.key })}
        />
        <MonoTag className={cn('shrink-0', !included && 'text-muted-foreground')}>{task.key}</MonoTag>
        <div className="min-w-[200px] flex-1">
          <input
            value={task.title}
            onChange={(e) => onChange({ title: e.target.value })}
            aria-label={t('tasks:briefImport.review.titleLabel', { key: task.key })}
            aria-invalid={titleEmpty || undefined}
            className={cn(
              // Frameless until hovered or focused (outline, so no layout shift); red frame when empty
              'h-9 w-full bg-transparent px-2 text-[15px] font-semibold tracking-[-0.01em] text-foreground -outline-offset-1',
              'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring',
              titleEmpty ? 'outline outline-1 outline-destructive' : 'hover:outline hover:outline-1 hover:outline-border',
              !included && 'text-muted-foreground line-through decoration-1'
            )}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <CompactSelect
            label={t('tasks:briefImport.review.complexity')}
            value={task.complexity}
            options={COMPLEXITIES}
            renderValue={(x) => v('complexity', x)}
            onChange={(complexity) => onChange({ complexity })}
          />
          <CompactSelect
            label={t('tasks:briefImport.review.priority')}
            value={task.priority}
            options={PRIORITIES}
            renderValue={(x) => v('priority', x)}
            onChange={(priority) => onChange({ priority })}
          />
          <CompactSelect
            label={t('tasks:briefImport.review.category')}
            value={task.category}
            options={CATEGORIES}
            renderValue={(x) => v('category', x)}
            onChange={(category) => onChange({ category })}
          />
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={t(expanded ? 'tasks:briefImport.review.collapse' : 'tasks:briefImport.review.expand', { key: task.key })}
            className={cn(ghostButton, 'w-11 px-0', expanded && 'text-foreground')}
          >
            {expanded ? <ChevronDown aria-hidden className="h-4 w-4" /> : <ChevronRight aria-hidden className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Second line: dependencies, source, what changes when tasks are left out */}
      {(task.dependsOn.length > 0 || task.sourceSection || !included || titleEmpty) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pr-3 pb-3 pl-11 text-xs text-muted-foreground">
          {!included && (
            <span className="inline-flex h-5 items-center bg-accent px-1.5 text-[11px] font-medium text-muted-foreground">
              {t('tasks:briefImport.review.notCreated')}
            </span>
          )}
          {task.dependsOn.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1">
              <span>{t('tasks:briefImport.review.after')}</span>
              {task.dependsOn.map((dep) => {
                const dropped = lost.includes(dep);
                return (
                  <span
                    key={dep}
                    className={cn(
                      'inline-flex h-5 items-center px-1 font-mono text-[11px]',
                      dropped ? 'border border-dashed border-muted-foreground text-muted-foreground line-through' : 'border border-border text-foreground'
                    )}
                  >
                    {dep}
                    {dropped && <span className="sr-only"> {t('tasks:briefImport.review.droppedSr')}</span>}
                  </span>
                );
              })}
            </span>
          )}
          {task.sourceSection && (
            <span className="min-w-0 truncate">
              <span className="mr-1">{t('tasks:briefImport.review.source')}</span>
              <span className="font-mono text-[11px] text-foreground">{task.sourceSection}</span>
            </span>
          )}
          {titleEmpty && <span className="text-destructive">{t('tasks:briefImport.review.titleRequired')}</span>}
          {included && lost.length > 0 && (
            <p className="basis-full border-l-2 border-foreground pl-2 text-foreground">
              {t('tasks:briefImport.review.losesDependency', { count: lost.length, keys: lost.join(', ') })}
            </p>
          )}
          {!included && dependents.length > 0 && (
            <p className="basis-full border-l-2 border-foreground pl-2 text-foreground">
              {t('tasks:briefImport.review.dependentsLose', { count: dependents.length, keys: dependents.join(', ') })}
            </p>
          )}
        </div>
      )}

      {expanded && (
        <div id={detailsId} className="space-y-5 border-t border-border bg-background px-4 py-4 sm:pl-11">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              {t('tasks:briefImport.review.description')}
            </span>
            <textarea
              rows={4}
              value={task.description}
              onChange={(e) => onChange({ description: e.target.value })}
              className={cn(fieldClass, 'resize-y leading-relaxed')}
            />
          </label>

          <fieldset>
            <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              {t('tasks:briefImport.review.acceptanceCriteria')}
              <span className="ml-2 font-mono font-normal normal-case tracking-normal">{task.acceptanceCriteria.length}</span>
            </legend>
            {task.acceptanceCriteria.length === 0 ? (
              <p className="border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                {t('tasks:briefImport.review.noCriteria')}
              </p>
            ) : (
              <ol className="border border-foreground">
                {task.acceptanceCriteria.map((ac, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: criteria are plain strings edited in place; position is their identity
                    key={index}
                    className="flex items-start gap-2 border-b border-border pl-3 last:border-b-0"
                  >
                    <span className="w-11 shrink-0 pt-3 font-mono text-[11px] text-muted-foreground">AC-{index + 1}</span>
                    <textarea
                      rows={2}
                      value={ac}
                      onChange={(e) => setCriterion(index, e.target.value)}
                      aria-label={t('tasks:briefImport.review.criterionLabel', { key: task.key, index: index + 1 })}
                      placeholder={t('tasks:briefImport.review.criterionPlaceholder')}
                      className="my-1.5 min-h-[44px] flex-1 resize-y bg-transparent px-2 py-1.5 text-sm leading-relaxed text-foreground -outline-offset-1 placeholder:text-muted-foreground hover:outline hover:outline-1 hover:outline-border focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
                    />
                    <button
                      type="button"
                      onClick={() => removeCriterion(index)}
                      aria-label={t('tasks:briefImport.review.removeCriterion', { index: index + 1 })}
                      className={cn(ghostButton, 'w-11 shrink-0 px-0')}
                    >
                      <X aria-hidden className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <button type="button" onClick={addCriterion} className={cn(ghostButton, 'mt-1 -ml-3 text-foreground')}>
              <Plus aria-hidden className="h-4 w-4" />
              {t('tasks:briefImport.review.addCriterion')}
            </button>
          </fieldset>
        </div>
      )}
    </li>
  );
}
