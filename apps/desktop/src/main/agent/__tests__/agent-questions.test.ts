import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addPendingQuestion,
  answerPendingQuestion,
  clearPendingQuestions,
  cancelPendingQuestion,
  dropQuestionsFrom,
  listPendingQuestions,
  onQuestionEvent,
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

describe('question events (for listeners such as the Telegram bot)', () => {
  beforeEach(() => clearPendingQuestions());

  it('tells listeners when a question is asked and how it ended', () => {
    const events: Array<[string, string, string?]> = [];
    const off = onQuestionEvent((event) => {
      events.push([event.type, event.question.questionId, event.type === 'resolved' ? event.how : undefined]);
    });
    const bridge = { answerQuestion: vi.fn() };
    addPendingQuestion(q('q1', 't1', 1), bridge);
    addPendingQuestion(q('q2', 't1', 2), bridge);
    addPendingQuestion(q('q3', 't1', 3), bridge);
    addPendingQuestion(q('q4', 't1', 4), bridge);
    answerPendingQuestion('q1', { 'Which DB?': 'Postgres' });
    answerPendingQuestion('q2', null);
    cancelPendingQuestion('q3');
    dropQuestionsFrom(bridge);
    off();
    addPendingQuestion(q('q5', 't1', 5), bridge);
    expect(events).toEqual([
      ['asked', 'q1', undefined],
      ['asked', 'q2', undefined],
      ['asked', 'q3', undefined],
      ['asked', 'q4', undefined],
      ['resolved', 'q1', 'answered'],
      ['resolved', 'q2', 'dismissed'],
      ['resolved', 'q3', 'cancelled'],
      ['resolved', 'q4', 'dropped'],
    ]);
  });

  it('a throwing listener does not break answering', () => {
    const off = onQuestionEvent(() => {
      throw new Error('boom');
    });
    const bridge = { answerQuestion: vi.fn() };
    addPendingQuestion(q('q1', 't1', 1), bridge);
    expect(answerPendingQuestion('q1', {})?.questionId).toBe('q1');
    expect(bridge.answerQuestion).toHaveBeenCalled();
    off();
  });
});
