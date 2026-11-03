/**
 * Pipeline and subtask marks shared by the board cards and the task Overview.
 *
 * StageTicks — six squares, one per pipeline stage: passed = ink at reduced
 * strength, current = solid ink (it "breathes" while an agent works), failed =
 * vermilion with a cross, upcoming = hollow hairline. Always paired with words.
 *
 * SubtaskBar — one segment per subtask (done / in progress / failed / pending).
 */

import { useTranslation } from 'react-i18next';
import type { Subtask } from '../../../shared/types';
import { cn } from '../../lib/utils';
import { PIPELINE_STAGES, type PipelineStage, type StageState, type TaskStageInfo } from './task-stage';

export function stageTickClass(state: StageState, breathing: boolean): string {
  return cn(
    'block h-2 w-2 shrink-0',
    state === 'done' && 'bg-muted-foreground/45',
    state === 'current' && 'bg-foreground',
    state === 'current' && breathing && 'vt-breathe',
    state === 'failed' && 'bg-destructive',
    state === 'upcoming' && 'border border-muted-foreground'
  );
}

export function StageTicks({ info, className }: { info: TaskStageInfo; className?: string }) {
  const { t } = useTranslation('tasks');
  const index = info.current ? PIPELINE_STAGES.indexOf(info.current) + 1 : 0;
  const label = info.finished
    ? t('board.stage.allPassed')
    : info.current
      ? t('board.stage.position', { index, total: PIPELINE_STAGES.length, stage: t(`board.stages.${info.current}`) })
      : t('board.stage.notStarted');
  return (
    <span role="img" aria-label={label} className={cn('inline-flex items-center gap-[3px]', className)}>
      {PIPELINE_STAGES.map((stage: PipelineStage) => (
        <span key={stage} aria-hidden="true" className={stageTickClass(info.states[stage], info.running && info.states[stage] === 'current')} />
      ))}
    </span>
  );
}

const MAX_SEGMENTS = 24;

export function SubtaskBar({ subtasks, className }: { subtasks: Subtask[]; className?: string }) {
  const total = subtasks.length;
  if (total === 0) return null;
  if (total > MAX_SEGMENTS) {
    const done = subtasks.filter((s) => s.status === 'completed').length;
    const failed = subtasks.filter((s) => s.status === 'failed').length;
    return (
      <div aria-hidden="true" className={cn('flex h-1 w-full bg-muted-foreground/25', className)}>
        <span className="h-full bg-foreground" style={{ width: `${(done / total) * 100}%` }} />
        {failed > 0 && <span className="h-full bg-destructive" style={{ width: `${(failed / total) * 100}%` }} />}
      </div>
    );
  }
  return (
    <div aria-hidden="true" className={cn('flex h-1 w-full gap-[2px]', className)}>
      {subtasks.map((s) => (
        <span
          key={s.id}
          className={cn(
            'h-full flex-1',
            s.status === 'completed' && 'bg-foreground',
            s.status === 'in_progress' && 'bg-muted-foreground',
            s.status === 'failed' && 'bg-destructive',
            s.status === 'pending' && 'bg-muted-foreground/25'
          )}
        />
      ))}
    </div>
  );
}
