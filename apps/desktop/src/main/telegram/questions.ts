/**
 * Agent questions in the chat. Each question of an ask comes as its own message with its
 * options as buttons (the recommended one first, marked ★) and "Other…" for a typed answer
 * (force-reply); multi-select questions toggle options and end with Done. When every question
 * has an answer, they go back together through the window's path (answerAgentQuestion).
 *
 * Answered or dismissed on the computer first → the chat messages say so and their buttons stop
 * working. An answer to a question that no longer waits is refused politely.
 */

import type { AgentAnswers, AgentQuestion, PendingAgentQuestion } from '../../shared/types/agent-questions';
import type { BotApi, InlineButton } from './bot-api';
import type { Translate } from './i18n';
import type { Router } from './router';

export interface QuestionFlowDeps {
  api: () => BotApi | undefined;
  router: Router;
  /** The owner's chat, when paired */
  chatId: () => number | undefined;
  t: Translate;
  answer: (questionId: string, answers: AgentAnswers | null) => { success: boolean; error?: string };
  taskTitle: (taskId: string, projectId?: string) => string;
  /** The "agent asks a question" switch */
  enabled: () => boolean;
}

type ResolvedHow = 'answered' | 'dismissed' | 'cancelled' | 'dropped';

interface Ask {
  question: PendingAgentQuestion;
  chatId: number;
  index: number;
  answers: AgentAnswers;
  /** Every message sent for this ask (edited when it ends elsewhere) */
  messageIds: number[];
  /** Multi-select: the labels chosen for the current question */
  selected: string[];
  /** The message of the current question */
  currentMessageId?: number;
  closed: boolean;
}

const RECOMMENDED = /\(recommended\)|\(рекомендовано\)/i;

/** Recommended options first (stable otherwise) */
export function orderOptions(question: AgentQuestion): AgentQuestion['options'] {
  return [...question.options].sort((a, b) => Number(RECOMMENDED.test(b.label)) - Number(RECOMMENDED.test(a.label)));
}

export function createQuestionFlow(deps: QuestionFlowDeps) {
  const asks = new Map<string, Ask>();
  const group = (ask: Ask) => `q:${ask.question.questionId}`;

  const questionText = (ask: Ask): string => {
    const q = ask.question.questions[ask.index];
    const lines = [deps.t('question.title', { task: deps.taskTitle(ask.question.taskId, ask.question.projectId) })];
    if (ask.question.questions.length > 1) lines.push(deps.t('question.counter', { index: ask.index + 1, total: ask.question.questions.length }));
    lines.push('', q.question);
    const described = orderOptions(q).filter((o) => o.description?.trim());
    if (described.length) lines.push('', ...described.map((o) => `• ${o.label}: ${o.description}`));
    return lines.join('\n');
  };

  const stillOpen = (ask: Ask) => !ask.closed && asks.get(ask.question.questionId) === ask;

  const refuse = async (ask: Ask) => {
    await deps.api()?.sendMessage(ask.chatId, deps.t('question.noLongerWaiting'));
  };

  const buttonsFor = (ask: Ask): InlineButton[][] => {
    const q = ask.question.questions[ask.index];
    const rows: InlineButton[][] = orderOptions(q).map((option) => {
      const recommended = RECOMMENDED.test(option.label);
      const chosen = q.multiSelect && ask.selected.includes(option.label);
      const text = chosen
        ? deps.t('question.selected', { label: option.label })
        : recommended
          ? deps.t('question.recommended', { label: option.label })
          : option.label;
      return [deps.router.button(text, () => choose(ask, option.label), group(ask))];
    });
    rows.push([deps.router.button(deps.t('question.other'), () => askForText(ask), group(ask))]);
    if (q.multiSelect && ask.selected.length) rows.push([deps.router.button(deps.t('question.done'), () => finishMulti(ask), group(ask))]);
    return rows;
  };

  const sendCurrent = async (ask: Ask) => {
    const api = deps.api();
    if (!api) return;
    const sent = await api.sendMessage(ask.chatId, questionText(ask), { buttons: buttonsFor(ask) });
    ask.currentMessageId = sent.message_id;
    ask.messageIds.push(sent.message_id);
  };

  const record = async (ask: Ask, answer: string) => {
    const q = ask.question.questions[ask.index];
    ask.answers[q.question] = answer;
    ask.selected = [];
    deps.router.forgetGroup(group(ask));
    if (ask.currentMessageId !== undefined) {
      await deps.api()?.editMessageText(ask.chatId, ask.currentMessageId, `${questionText(ask)}\n\n${deps.t('question.answered', { answer })}`);
    }
    if (ask.index + 1 < ask.question.questions.length) {
      ask.index++;
      await sendCurrent(ask);
      return;
    }
    // Every question has its answer: back to the agent, all together
    ask.closed = true;
    asks.delete(ask.question.questionId);
    const result = deps.answer(ask.question.questionId, ask.answers);
    await deps.api()?.sendMessage(ask.chatId, deps.t(result.success ? 'question.answeredHere' : 'question.noLongerWaiting'));
  };

  const choose = async (ask: Ask, label: string): Promise<void> => {
    if (!stillOpen(ask)) return refuse(ask);
    const q = ask.question.questions[ask.index];
    if (!q.multiSelect) return record(ask, label);
    ask.selected = ask.selected.includes(label) ? ask.selected.filter((l) => l !== label) : [...ask.selected, label];
    // New buttons for the new state (the old ones go)
    deps.router.forgetGroup(group(ask));
    if (ask.currentMessageId !== undefined) {
      await deps.api()?.editMessageText(ask.chatId, ask.currentMessageId, questionText(ask), { buttons: buttonsFor(ask) });
    }
  };

  const finishMulti = async (ask: Ask): Promise<void> => {
    if (!stillOpen(ask)) return refuse(ask);
    const q = ask.question.questions[ask.index];
    // In the option order, as the window does
    const chosen = q.options.map((o) => o.label).filter((l) => ask.selected.includes(l));
    await record(ask, chosen.join(', '));
  };

  const askForText = async (ask: Ask): Promise<void> => {
    if (!stillOpen(ask)) return refuse(ask);
    const api = deps.api();
    if (!api) return;
    const q = ask.question.questions[ask.index];
    const prompt = await api.sendMessage(ask.chatId, deps.t('question.otherPrompt', { question: q.question }), { forceReply: true, placeholder: q.header });
    ask.messageIds.push(prompt.message_id);
    const index = ask.index;
    deps.router.awaitReply(prompt.message_id, async (text) => {
      if (!stillOpen(ask) || ask.index !== index) return refuse(ask);
      const typed = text.trim();
      if (!typed) return;
      const answer = q.multiSelect ? [...q.options.map((o) => o.label).filter((l) => ask.selected.includes(l)), typed].join(', ') : typed;
      await record(ask, answer);
    });
  };

  return {
    async asked(question: PendingAgentQuestion): Promise<void> {
      const chatId = deps.chatId();
      if (!deps.enabled() || chatId === undefined || !question.questions.length) return;
      const ask: Ask = { question, chatId, index: 0, answers: {}, messageIds: [], selected: [], closed: false };
      asks.set(question.questionId, ask);
      await sendCurrent(ask);
    },
    /** The question stopped waiting (an answer from the window, or the agent gave up) */
    resolved(question: PendingAgentQuestion, how: ResolvedHow): void {
      const ask = asks.get(question.questionId);
      if (!ask) return;
      ask.closed = true;
      asks.delete(question.questionId);
      deps.router.forgetGroup(group(ask));
      const note = deps.t(how === 'answered' || how === 'dismissed' ? 'question.answeredOnComputer' : 'question.dismissed');
      const api = deps.api();
      if (!api || ask.currentMessageId === undefined) return;
      void api.editMessageText(ask.chatId, ask.currentMessageId, `${questionText(ask)}\n\n${note}`).catch(() => undefined);
    },
    /** Forget every open ask (unpair, token change) */
    reset(): void {
      asks.clear();
    },
  };
}

export type QuestionFlow = ReturnType<typeof createQuestionFlow>;
