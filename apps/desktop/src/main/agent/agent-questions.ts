/**
 * Pending agent questions (main process).
 *
 * A worker's agent asks via Claude Code's AskUserQuestion; the WorkerBridge
 * surfaces it here. The renderer lists and answers pending questions over IPC;
 * the answer goes back to the same bridge. Questions of a task that exits are
 * dropped (the agent is gone).
 */

import type { AgentAnswers, PendingAgentQuestion } from '../../shared/types/agent-questions';

interface Answerable {
  answerQuestion(questionId: string, answers: AgentAnswers | null): void;
}

const pending = new Map<string, { question: PendingAgentQuestion; target: Answerable }>();

/**
 * How a question stopped waiting: answered or dismissed by the user (from any client), cancelled
 * by the agent, or dropped because its worker ended.
 */
export type QuestionEvent =
  | { type: 'asked'; question: PendingAgentQuestion }
  | { type: 'resolved'; question: PendingAgentQuestion; how: 'answered' | 'dismissed' | 'cancelled' | 'dropped' };

const listeners = new Set<(event: QuestionEvent) => void>();

/** Listen to questions being asked and resolved (the Telegram bot). Returns the unsubscribe. */
export function onQuestionEvent(listener: (event: QuestionEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: QuestionEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A listener never breaks asking or answering
    }
  }
}

export function addPendingQuestion(question: PendingAgentQuestion, target: Answerable): void {
  pending.set(question.questionId, { question, target });
  emit({ type: 'asked', question });
}

export function listPendingQuestions(): PendingAgentQuestion[] {
  return [...pending.values()].map((entry) => entry.question).sort((a, b) => a.askedAt - b.askedAt);
}

/** Deliver answers (or null = dismissed). Returns the resolved question, if it was pending. */
export function answerPendingQuestion(questionId: string, answers: AgentAnswers | null): PendingAgentQuestion | null {
  const entry = pending.get(questionId);
  if (!entry) return null;
  pending.delete(questionId);
  entry.target.answerQuestion(questionId, answers);
  emit({ type: 'resolved', question: entry.question, how: answers ? 'answered' : 'dismissed' });
  return entry.question;
}

/** Forget one question without answering it (the agent stopped waiting). */
export function cancelPendingQuestion(questionId: string): PendingAgentQuestion | null {
  const entry = pending.get(questionId);
  if (!entry) return null;
  pending.delete(questionId);
  emit({ type: 'resolved', question: entry.question, how: 'cancelled' });
  return entry.question;
}

/**
 * Forget every question asked through one worker (it finished or was stopped).
 * Keyed by asker, not task, so a restarted task keeps its new questions.
 */
export function dropQuestionsFrom(target: Answerable): PendingAgentQuestion[] {
  const dropped: PendingAgentQuestion[] = [];
  for (const [id, entry] of pending) {
    if (entry.target === target) {
      pending.delete(id);
      dropped.push(entry.question);
    }
  }
  for (const question of dropped) emit({ type: 'resolved', question, how: 'dropped' });
  return dropped;
}

/** Test helper */
export function clearPendingQuestions(): void {
  pending.clear();
}
