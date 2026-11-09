/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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
import { shortDependency, TaskCard } from '../../TaskCard';

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

  describe('a task whose pentest did not finish', () => {
    const inReview = (overrides: Partial<Task> = {}) =>
      task({ status: 'human_review', reviewReason: 'completed', executionProgress: { phase: 'complete', phaseProgress: 100, overallProgress: 100 }, ...overrides });
    const answers = (data: unknown) => {
      (window as unknown as { electronAPI: unknown }).electronAPI = { getTaskSecurityQaError: vi.fn(async () => ({ success: true, data })) };
    };

    it('says so instead of only QA passed', async () => {
      answers({ reason: 'Strix exited with code 1' });
      render(<TaskCard task={inReview()} onClick={vi.fn()} />);
      expect(await screen.findByText('board.chip.securityQaFailed')).toBeInTheDocument();
      expect(screen.queryByText('board.chip.qaPassed')).not.toBeInTheDocument();
    });

    it('says a UI task auto-merge held is waiting for your preview', async () => {
      answers(null);
      render(<TaskCard task={inReview({ waitingForPreview: true })} onClick={vi.fn()} />);
      expect(await screen.findByText('board.chip.waitingForPreview')).toBeInTheDocument();
      expect(screen.queryByText('board.chip.qaPassed')).not.toBeInTheDocument();
    });

    it('stays QA passed when the scan had no error', async () => {
      answers(null);
      render(<TaskCard task={inReview()} onClick={vi.fn()} />);
      await waitFor(() => expect(window.electronAPI.getTaskSecurityQaError).toHaveBeenCalled());
      expect(screen.getByText('board.chip.qaPassed')).toBeInTheDocument();
    });
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

  it('shows what a not-started task waits on, by spec number', () => {
    const deps = { dependencies: ['012-invoice-api', '014-pdf'] };
    const { unmount } = render(
      <TaskCard task={task({ status: 'queue', subtasks: [], executionProgress: undefined, metadata: deps })} onClick={vi.fn()} />
    );
    expect(screen.getByText('briefImport.card.after {"list":"012, 014"}')).toBeInTheDocument();
    unmount();
    render(<TaskCard task={task({ status: 'in_progress', metadata: deps })} onClick={vi.fn()} />);
    expect(screen.queryByText(/briefImport\.card\.after/)).not.toBeInTheDocument();
  });

  it('shortens spec ids to their number', () => {
    expect(shortDependency('012-invoice-api')).toBe('012');
    expect(shortDependency('7')).toBe('7');
    expect(shortDependency('custom-id')).toBe('custom-id');
  });
});
