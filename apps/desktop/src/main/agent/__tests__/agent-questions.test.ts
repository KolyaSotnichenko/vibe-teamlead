import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addPendingQuestion,
  answerPendingQuestion,
  clearPendingQuestions,
  dropTaskQuestions,
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

  it('drops questions of a finished task', () => {
    addPendingQuestion(q('q1', 't1', 1), { answerQuestion: vi.fn() });
    addPendingQuestion(q('q2', 't2', 2), { answerQuestion: vi.fn() });
    expect(dropTaskQuestions('t1').map((x) => x.questionId)).toEqual(['q1']);
    expect(listPendingQuestions().map((x) => x.questionId)).toEqual(['q2']);
  });
});
