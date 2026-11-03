/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { Task } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en' },
  }),
}));

const startTaskOrQueue = vi.fn(async () => ({ success: true, action: 'started' }));
const stopTask = vi.fn();
vi.mock('../../../stores/task-store', () => ({
  stopTask: (...args: unknown[]) => stopTask(...args),
  startTaskOrQueue: (...args: unknown[]) => startTaskOrQueue(...(args as [])),
  checkTaskRunning: vi.fn(async () => true),
  recoverStuckTask: vi.fn(async () => ({ success: true })),
  archiveTasks: vi.fn(async () => ({ success: true })),
  hasRecentActivity: vi.fn(() => true),
  isIncompleteHumanReview: () => false,
}));

vi.mock('../../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { useAgentQuestionsStore } from '../../../stores/agent-questions-store';
import { TaskCard } from '../../TaskCard';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-a',
    specId: '001-a',
    projectId: 'p',
    title: 'Build dashboard',
    description: 'Charts',
    status: 'in_progress',
    subtasks: [
      { id: 's1', title: 'Chart lib', description: '', status: 'completed', files: [] },
      { id: 's2', title: 'Layout', description: '', status: 'in_progress', files: [] },
      { id: 's3', title: 'Data', description: '', status: 'pending', files: [] },
    ],
    logs: [],
    executionProgress: { phase: 'coding', phaseProgress: 0, overallProgress: 0, currentSubtask: 's2' },
    location: 'worktree',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('TaskCard', () => {
  beforeEach(() => {
    useAgentQuestionsStore.setState({ pending: [], openQuestionId: null });
    startTaskOrQueue.mockClear();
    stopTask.mockClear();
  });

  it('shows who is working, on what, and the subtask count', () => {
    render(<TaskCard task={task()} onClick={vi.fn()} />);
    expect(screen.getByText('board.agents.coder')).toBeInTheDocument();
    expect(screen.getByText('Layout')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
    expect(screen.getByText('board.worktree')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /board\.stage\.position/ })).toBeInTheDocument();
  });

  it('stops a running task without opening it', () => {
    const onClick = vi.fn();
    render(<TaskCard task={task()} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'actions.stop' }));
    expect(stopTask).toHaveBeenCalledWith('task-a');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('starts a backlog task', () => {
    render(<TaskCard task={task({ status: 'backlog', executionProgress: undefined, subtasks: [] })} onClick={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'actions.start' }));
    expect(startTaskOrQueue).toHaveBeenCalledWith('task-a');
  });

  it('keeps the waiting-for-you chip and opens the question', () => {
    useAgentQuestionsStore.setState({
      pending: [{ questionId: 'q1', taskId: 'task-a', agentType: 'coder', askedAt: Date.now(), questions: [] }],
      openQuestionId: null,
    });
    const onClick = vi.fn();
    render(<TaskCard task={task()} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /agentQuestions\.waiting/ }));
    expect(useAgentQuestionsStore.getState().openQuestionId).toBe('q1');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('names the review reason in words', () => {
    render(<TaskCard task={task({ status: 'human_review', reviewReason: 'qa_rejected', executionProgress: undefined })} onClick={vi.fn()} />);
    expect(screen.getByText('reviewReason.qaIssues')).toBeInTheDocument();
  });

  it('selection checkbox toggles without opening the task', () => {
    const onToggle = vi.fn();
    const onClick = vi.fn();
    render(<TaskCard task={task()} onClick={onClick} isSelectable isSelected={false} onToggleSelect={onToggle} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });
});
