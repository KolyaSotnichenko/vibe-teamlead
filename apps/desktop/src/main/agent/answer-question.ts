/**
 * Answering an agent's question, from the window (IPC) or from the Telegram bot: the same path.
 * The answer goes back to the asking agent, a task made from a brief shares it with the brief's
 * other tasks, and the window hears that the question was resolved.
 */

import type { Project, Task } from '../../shared/types';
import type { AgentAnswers, PendingAgentQuestion } from '../../shared/types/agent-questions';
import { answerPendingQuestion } from './agent-questions';

export const NO_LONGER_WAITING = 'This question is no longer waiting for an answer.';

export interface AnswerQuestionDeps {
  findTaskAndProject: (taskId: string, projectId?: string) => { task?: Task; project?: Project };
  recordBriefAnswers: (project: Project, task: Task, question: PendingAgentQuestion, answers: AgentAnswers | null) => void;
  onResolved: (questionId: string, taskId: string) => void;
}

export function answerQuestion(questionId: string, answers: AgentAnswers | null, deps: AnswerQuestionDeps): { success: boolean; error?: string } {
  const question = answerPendingQuestion(questionId, answers);
  if (!question) return { success: false, error: NO_LONGER_WAITING };
  const { task, project } = deps.findTaskAndProject(question.taskId, question.projectId);
  if (task && project) deps.recordBriefAnswers(project, task, question, answers);
  deps.onResolved(questionId, question.taskId);
  return { success: true };
}

let shared: ((questionId: string, answers: AgentAnswers | null) => { success: boolean; error?: string }) | undefined;

/** Set once the IPC handlers are registered (they know the window) */
export function setSharedAnswerer(answer: typeof shared): void {
  shared = answer;
}

/** Answer as the window does (used by the Telegram bot) */
export function answerAgentQuestion(questionId: string, answers: AgentAnswers | null): { success: boolean; error?: string } {
  return shared ? shared(questionId, answers) : { success: false, error: NO_LONGER_WAITING };
}
