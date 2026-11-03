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

export function addPendingQuestion(question: PendingAgentQuestion, target: Answerable): void {
  pending.set(question.questionId, { question, target });
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
  return entry.question;
}

/** Forget one question without answering it (the agent stopped waiting). */
export function cancelPendingQuestion(questionId: string): PendingAgentQuestion | null {
  const entry = pending.get(questionId);
  if (!entry) return null;
  pending.delete(questionId);
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
  return dropped;
}

/** Test helper */
export function clearPendingQuestions(): void {
  pending.clear();
}
