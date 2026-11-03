import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addPendingQuestion,
  answerPendingQuestion,
  clearPendingQuestions,
  cancelPendingQuestion,
  dropQuestionsFrom,
  listPendingQuestions,
} from '../agent-questions';

const q = (questionId: string, taskId: string, askedAt: number) => ({
  questionId,
  taskId,
  agentType: 'spec_gatherer',
  askedAt,
  questions: [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [] }],
});

describe('pending agent questions', () => {
  beforeEach(() => clearPendingQuestions());

  it('lists oldest first and routes the answer back to the asking agent', () => {
    const bridgeA = { answerQuestion: vi.fn() };
    const bridgeB = { answerQuestion: vi.fn() };
    addPendingQuestion(q('q2', 't2', 2), bridgeB);
    addPendingQuestion(q('q1', 't1', 1), bridgeA);
    expect(listPendingQuestions().map((x) => x.questionId)).toEqual(['q1', 'q2']);

    expect(answerPendingQuestion('q1', { 'Which DB?': 'Postgres' })?.taskId).toBe('t1');
    expect(bridgeA.answerQuestion).toHaveBeenCalledWith('q1', { 'Which DB?': 'Postgres' });
    expect(bridgeB.answerQuestion).not.toHaveBeenCalled();
    expect(answerPendingQuestion('q1', null)).toBeNull();
  });

  it('drops only the questions of the worker that ended, even for the same task', () => {
    const oldWorker = { answerQuestion: vi.fn() };
    const restarted = { answerQuestion: vi.fn() };
    addPendingQuestion(q('q1', 't1', 1), oldWorker);
    addPendingQuestion(q('q2', 't1', 2), restarted);
    expect(dropQuestionsFrom(oldWorker).map((x) => x.questionId)).toEqual(['q1']);
    expect(listPendingQuestions().map((x) => x.questionId)).toEqual(['q2']);
  });

  it('cancels a question the agent stopped waiting for, without answering it', () => {
    const bridge = { answerQuestion: vi.fn() };
    addPendingQuestion(q('q1', 't1', 1), bridge);
    expect(cancelPendingQuestion('q1')?.questionId).toBe('q1');
    expect(cancelPendingQuestion('q1')).toBeNull();
    expect(bridge.answerQuestion).not.toHaveBeenCalled();
  });
});
