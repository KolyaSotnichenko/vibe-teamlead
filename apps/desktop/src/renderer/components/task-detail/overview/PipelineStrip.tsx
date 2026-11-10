/**
 * The pipeline as a seven-cell datasheet row: spec → design → architect → planner → coder → QA → review.
 * The current stage is the one ink-filled cell (its square breathes while an agent works);
 * a stage that sent the task back shows ✕ and "Sent back" in vermilion.
 * Cells open the part of the task that stage writes.
 */

import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { PIPELINE_STAGES, type PipelineStage, type TaskStageInfo } from '../../board/task-stage';
import { SectionHeader } from '../workspace/workspace-ui';

export type StageTarget = 'spec' | 'design' | 'architecture' | 'plan' | 'subtasks' | 'security' | null;

const STAGE_TARGET: Record<PipelineStage, StageTarget> = {
  spec: 'spec',
  designer: 'design',
  architect: 'architecture',
  planner: 'plan',
  coder: 'subtasks',
  qa: 'security',
  review: null,
};

export function PipelineStrip({
  info,
  message,
  waitingStage,
  onOpen,
}: {
  info: TaskStageInfo;
  /** executionProgress.message while running */
  message?: string;
  /** Stage whose agent is waiting for the user's answer */
  waitingStage?: PipelineStage | null;
  onOpen: (target: Exclude<StageTarget, null>) => void;
}) {
  const { t } = useTranslation('tasks');

  const stateWord = (stage: PipelineStage): { word: string; attention: boolean } => {
    const state = info.states[stage];
    if (stage === waitingStage && state === 'current') return { word: t('agentQuestions.waiting'), attention: true };
    if (state === 'done') return { word: t('overview.pipeline.state.done'), attention: false };
    if (state === 'failed') return { word: t('overview.pipeline.state.failed'), attention: true };
    if (state === 'upcoming') return { word: t('overview.pipeline.state.upcoming'), attention: false };
    if (info.paused) return { word: t(`board.chip.paused.${info.paused}`), attention: true };
    if (stage === 'review' || info.agent === 'you') return { word: t('overview.pipeline.state.yourTurn'), attention: false };
    if (info.running) return { word: t(`board.agents.${info.agent ?? stage}`), attention: false };
    return { word: t('overview.pipeline.state.stopped'), attention: true };
  };

  return (
    <section aria-labelledby="overview-pipeline">
      <SectionHeader
        id="overview-pipeline"
        title={t('overview.pipeline.title')}
        meta={info.running && message ? message : info.finished ? t('board.stage.allPassed') : undefined}
      />
      <ol className="mt-3 grid grid-cols-2 gap-px border border-foreground bg-border sm:grid-cols-4 lg:grid-cols-7">
        {PIPELINE_STAGES.map((stage, index) => {
          const state = info.states[stage];
          const current = state === 'current';
          const { word, attention } = stateWord(stage);
          const target = STAGE_TARGET[stage];
          const content = (
            <>
              <span className="flex items-center justify-between">
                <span
                  aria-hidden="true"
                  className={cn(
                    'block h-2 w-2',
                    state === 'done' && (current ? 'bg-primary-foreground' : 'bg-muted-foreground'),
                    current && 'bg-primary-foreground',
                    current && info.running && 'vt-breathe',
                    state === 'failed' && 'bg-destructive',
                    state === 'upcoming' && 'border border-muted-foreground/60'
                  )}
                />
                <span className={cn('font-mono text-[11px] tabular-nums', current ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                  {index + 1}
                </span>
              </span>
              <span className={cn('mt-3 block text-sm font-semibold', current ? 'text-primary-foreground' : state === 'upcoming' ? 'text-muted-foreground' : 'text-foreground')}>
                {t(`board.stages.${stage}`)}
              </span>
              <span
                className={cn(
                  'mt-0.5 flex items-center gap-1 text-xs',
                  attention
                    ? current
                      ? 'font-semibold text-[var(--vt-signal-on-dark)] dark:text-[var(--vt-signal-text)]'
                      : 'font-semibold text-destructive'
                    : current
                      ? 'text-primary-foreground/80'
                      : 'text-muted-foreground'
                )}
              >
                {state === 'failed' && <span aria-hidden="true">✕</span>}
                {state === 'done' && <span aria-hidden="true">✓</span>}
                {word}
              </span>
              <span className={cn('mt-2 block text-[11px] leading-snug', current ? 'text-primary-foreground/60' : 'text-muted-foreground')}>
                {t(`overview.pipeline.writes.${stage}`)}
              </span>
            </>
          );
          const cellClass = cn(
            'flex h-full min-h-[116px] w-full flex-col px-3 py-3 text-left',
            current ? 'bg-primary' : 'bg-transparent'
          );
          return (
            <li
              key={stage}
              aria-current={current ? 'step' : undefined}
              className="bg-background"
            >
              {target ? (
                <button
                  type="button"
                  onClick={() => onOpen(target)}
                  className={cn(cellClass, !current && 'hover:bg-accent', 'focus-visible:outline-2 focus-visible:-outline-offset-2')}
                >
                  {content}
                </button>
              ) : (
                <div className={cellClass}>{content}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
