import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addPendingQuestion, clearPendingQuestions } from '../agent-questions';
import { answerQuestion, NO_LONGER_WAITING } from '../answer-question';

const question = {
  questionId: 'q1',
  taskId: 't1',
  projectId: 'p1',
  agentType: 'coder',
  askedAt: 1,
  questions: [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [] }],
};

describe('answerQuestion (the path the window and the Telegram bot share)', () => {
  beforeEach(() => clearPendingQuestions());

  it('delivers the answer, records brief answers and reports the question resolved', () => {
    const bridge = { answerQuestion: vi.fn() };
    addPendingQuestion(question, bridge);
    const task = { id: 't1' };
    const project = { id: 'p1' };
    const deps = {
      findTaskAndProject: vi.fn(() => ({ task, project })),
      recordBriefAnswers: vi.fn(),
      onResolved: vi.fn(),
    };
    expect(answerQuestion('q1', { 'Which DB?': 'Postgres' }, deps as never)).toEqual({ success: true });
    expect(bridge.answerQuestion).toHaveBeenCalledWith('q1', { 'Which DB?': 'Postgres' });
    expect(deps.findTaskAndProject).toHaveBeenCalledWith('t1', 'p1');
    expect(deps.recordBriefAnswers).toHaveBeenCalledWith(project, task, question, { 'Which DB?': 'Postgres' });
    expect(deps.onResolved).toHaveBeenCalledWith('q1', 't1');
  });

  it('refuses a question that no longer waits', () => {
    const deps = { findTaskAndProject: vi.fn(), recordBriefAnswers: vi.fn(), onResolved: vi.fn() };
    expect(answerQuestion('gone', null, deps as never)).toEqual({ success: false, error: NO_LONGER_WAITING });
    expect(deps.onResolved).not.toHaveBeenCalled();
  });
});
