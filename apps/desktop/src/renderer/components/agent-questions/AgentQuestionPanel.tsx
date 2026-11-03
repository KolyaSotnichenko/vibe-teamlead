/**
 * Agent question panel
 *
 * Shows questions an agent is waiting on (Claude Code AskUserQuestion),
 * docked on the right so the board stays visible. Design system: panel with a
 * 1px ink frame, radius 0, rows ≥44px separated by hairlines, vermilion only
 * for the "waiting for you" mark.
 */

import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AgentAnswers, AgentQuestion, PendingAgentQuestion } from '../../../shared/types/agent-questions';
import { cn } from '../../lib/utils';
import { useAgentQuestionsStore } from '../../stores/agent-questions-store';
import { useTaskStore } from '../../stores/task-store';

/** Selected option labels per question (+ optional free text) */
type Draft = Record<string, { selected: string[]; other: string }>;

const ROLE_KEYS: Array<[RegExp, string]> = [
  [/^spec/, 'spec'],
  [/^planner/, 'planner'],
  [/^coder/, 'coder'],
  [/^qa_fixer/, 'qaFixer'],
  [/^qa/, 'qa'],
];

export function roleKey(agentType: string): string {
  return ROLE_KEYS.find(([re]) => re.test(agentType))?.[1] ?? 'agent';
}

/** Build the answers map Claude Code expects. Exported for tests. */
export function toAnswers(questions: AgentQuestion[], draft: Draft): AgentAnswers | null {
  const answers: AgentAnswers = {};
  for (const q of questions) {
    const entry = draft[q.question];
    const parts = [...(entry?.selected ?? [])];
    const other = entry?.other.trim();
    if (other) parts.push(other);
    if (parts.length === 0) return null;
    answers[q.question] = parts.join(', ');
  }
  return answers;
}

function QuestionBlock({
  question,
  value,
  onChange,
}: {
  question: AgentQuestion;
  value: { selected: string[]; other: string };
  onChange: (next: { selected: string[]; other: string }) => void;
}) {
  const { t } = useTranslation('tasks');
  const toggle = (label: string) => {
    if (question.multiSelect) {
      const selected = value.selected.includes(label)
        ? value.selected.filter((l) => l !== label)
        : [...value.selected, label];
      onChange({ ...value, selected });
    } else {
      onChange({ selected: value.selected[0] === label ? [] : [label], other: '' });
    }
  };

  return (
    <fieldset className="border-t border-border pt-4">
      <legend className="sr-only">{question.question}</legend>
      <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">{question.header}</span>
      <p className="mt-1 text-base font-semibold leading-snug text-foreground">{question.question}</p>
      {question.multiSelect && (
        <p className="mt-1 text-xs text-muted-foreground">{t('agentQuestions.chooseSeveral')}</p>
      )}
      <div className="mt-3 border border-foreground" role={question.multiSelect ? 'group' : 'radiogroup'}>
        {question.options.map((option, index) => {
          const checked = value.selected.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              role={question.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={checked}
              onClick={() => toggle(option.label)}
              className={cn(
                'flex min-h-11 w-full items-start gap-3 px-3 py-2.5 text-left transition-colors',
                index > 0 && 'border-t border-border',
                checked ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-1 h-3 w-3 shrink-0 border',
                  checked ? 'border-primary-foreground bg-primary-foreground' : 'border-foreground',
                )}
              />
              <span className="flex-1">
                <span className="block text-sm font-medium">{option.label}</span>
                {option.description && (
                  <span className={cn('block text-xs', checked ? 'opacity-80' : 'text-muted-foreground')}>
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        <label className="block border-t border-border px-3 py-2.5">
          <span className="block text-xs text-muted-foreground">{t('agentQuestions.other')}</span>
          <textarea
            rows={2}
            value={value.other}
            onChange={(e) =>
              onChange({
                selected: question.multiSelect ? value.selected : [],
                other: e.target.value,
              })
            }
            placeholder={t('agentQuestions.otherPlaceholder')}
            className="mt-1 w-full resize-y border border-foreground bg-transparent px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
          />
        </label>
      </div>
    </fieldset>
  );
}

export function AgentQuestionPanel() {
  const { t } = useTranslation('tasks');
  const pending = useAgentQuestionsStore((s) => s.pending);
  const openQuestionId = useAgentQuestionsStore((s) => s.openQuestionId);
  const open = useAgentQuestionsStore((s) => s.open);
  const answer = useAgentQuestionsStore((s) => s.answer);
  const tasks = useTaskStore((s) => s.tasks);

  const index = pending.findIndex((q) => q.questionId === openQuestionId);
  const current: PendingAgentQuestion | undefined = index >= 0 ? pending[index] : undefined;
  const [draft, setDraft] = useState<Draft>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh draft per question.
  useEffect(() => {
    setDraft({});
    setError(null);
  }, [current?.questionId]);

  const answers = useMemo(() => (current ? toAnswers(current.questions, draft) : null), [current, draft]);

  if (!current) return null;

  const task = tasks.find((t) => t.id === current.taskId || t.specId === current.taskId);
  const submit = async (value: AgentAnswers | null) => {
    setSending(true);
    setError(null);
    const result = await answer(current.questionId, value);
    setSending(false);
    if (!result.success && result.error) setError(result.error);
  };

  return (
    <aside
      aria-labelledby="agent-question-title"
      className="fixed right-6 bottom-6 z-50 flex max-h-[calc(100vh-48px)] w-[440px] max-w-[calc(100vw-32px)] flex-col border border-foreground bg-card text-card-foreground"
    >
      <header className="flex items-start gap-3 border-b border-l-2 border-b-border border-l-[var(--vt-signal)] px-4 py-3">
        <div className="flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('agentQuestions.title', { role: t(`agentQuestions.roles.${roleKey(current.agentType)}`) })}
          </p>
          <h2 id="agent-question-title" className="mt-0.5 text-sm font-semibold text-foreground">
            {task?.title ?? current.taskId}
          </h2>
        </div>
        {pending.length > 1 && (
          <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <button
              type="button"
              aria-label={t('agentQuestions.previous')}
              className="flex h-8 w-8 items-center justify-center hover:bg-muted disabled:opacity-40"
              disabled={index === 0}
              onClick={() => open(pending[index - 1].questionId)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {index + 1}/{pending.length}
            <button
              type="button"
              aria-label={t('agentQuestions.next')}
              className="flex h-8 w-8 items-center justify-center hover:bg-muted disabled:opacity-40"
              disabled={index === pending.length - 1}
              onClick={() => open(pending[index + 1].questionId)}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
        <button
          type="button"
          aria-label={t('agentQuestions.hide')}
          className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => open(null)}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <p className="text-sm text-muted-foreground">{t('agentQuestions.intro')}</p>
        {current.questions.map((question) => (
          <QuestionBlock
            key={question.question}
            question={question}
            value={draft[question.question] ?? { selected: [], other: '' }}
            onChange={(next) => setDraft((d) => ({ ...d, [question.question]: next }))}
          />
        ))}
        {error && (
          <p role="alert" className="border-l-2 border-[var(--vt-signal-text)] pl-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <button
          type="button"
          disabled={sending}
          onClick={() => void submit(null)}
          className="min-h-11 px-3 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {t('agentQuestions.skip')}
        </button>
        <button
          type="button"
          disabled={sending || !answers}
          onClick={() => void submit(answers)}
          className="min-h-11 bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {sending ? t('agentQuestions.sending') : t('agentQuestions.send')}
        </button>
      </footer>
    </aside>
  );
}
