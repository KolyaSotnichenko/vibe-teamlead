/**
 * An agent of this task is paused on a question. Vermilion left mark (needs
 * attention), the first question in full, and one 44px "Answer" button that
 * opens the existing agent-question panel.
 */

import { useTranslation } from 'react-i18next';
import type { PendingAgentQuestion } from '../../../../shared/types/agent-questions';
import { roleKey } from '../../agent-questions/AgentQuestionPanel';
import type { PipelineStage } from '../../board/task-stage';
import { formatSince } from '../../board/task-stage';

/** Pipeline stage of the asking agent (spec_gatherer → spec, ...). Exported for tests. */
export function stageOfAgent(agentType: string): PipelineStage | null {
  if (/^architect/.test(agentType)) return 'architect';
  const role = roleKey(agentType);
  if (role === 'spec') return 'spec';
  if (role === 'planner') return 'planner';
  if (role === 'coder') return 'coder';
  if (role === 'qa' || role === 'qaFixer') return 'qa';
  return null;
}

export function PendingQuestion({ question, onAnswer }: { question: PendingAgentQuestion; onAnswer: () => void }) {
  const { t, i18n } = useTranslation('tasks');
  const role = /^architect/.test(question.agentType) ? t('board.agents.architect') : t(`agentQuestions.roles.${roleKey(question.agentType)}`);
  const first = question.questions[0];
  const more = question.questions.length - 1;
  const since = formatSince(new Date(question.askedAt), i18n.language);

  return (
    <section
      aria-labelledby="overview-question"
      className="relative flex flex-wrap items-center gap-x-6 gap-y-3 border border-destructive bg-card py-3 pr-3 pl-5"
    >
      <span aria-hidden className="absolute inset-y-[-1px] left-[-1px] w-[3px] bg-destructive" />
      <div className="min-w-0 flex-1">
        <h3 id="overview-question" className="flex items-center gap-2 text-sm font-semibold text-destructive">
          <span aria-hidden className="vt-breathe h-2 w-2 bg-destructive" />
          {t('agentQuestions.title', { role })}
          {since && <span className="font-mono text-xs font-normal text-muted-foreground">{since}</span>}
        </h3>
        {first && <p className="mt-1 text-[15px] leading-snug text-foreground">{first.question}</p>}
        {more > 0 && <p className="mt-1 text-xs text-muted-foreground">{t('overview.question.more', { count: more })}</p>}
      </div>
      <button
        type="button"
        onClick={onAnswer}
        className="inline-flex h-11 shrink-0 items-center bg-destructive px-5 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90"
      >
        {t('agentQuestions.openQuestion')}
      </button>
    </section>
  );
}
