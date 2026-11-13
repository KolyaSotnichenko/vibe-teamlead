/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Task } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en' },
  }),
}));

const startTaskOrQueue = vi.fn(async () => ({ success: true, action: 'started' }));
const stopTask = vi.fn();
const deleteTask = vi.fn(async () => ({ success: true }));
vi.mock('../../../stores/task-store', () => ({
  deleteTask: (...args: unknown[]) => deleteTask(...(args as [])),
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
import { resetPreviewSubscription } from '../../task-detail/useCiState';

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

  describe('layout (Variant A)', () => {
    afterEach(() => {
      cleanup();
      resetPreviewSubscription();
    });

    it('puts priority and time in a meta row inside the body, not in the strip', () => {
      render(<TaskCard task={task({ metadata: { priority: 'urgent' } })} onClick={vi.fn()} onStatusChange={vi.fn()} />);
      const meta = screen.getByTestId('task-meta-row');
      const strip = screen.getByTestId('task-action-strip');
      expect(meta).toHaveClass('flex-wrap');
      expect(meta.querySelector('[data-testid="priority-chip"]')).toHaveClass('uppercase', 'bg-destructive');
      expect(meta.querySelector('time')).toBeInTheDocument();
      expect(meta.textContent).toContain('board.worktree');
      expect(strip.contains(meta)).toBe(false);
      expect(strip.querySelector('time')).toBeNull();
    });

    it.each(['urgent', 'high'])('styles %s priority as a signal chip', (priority) => {
      render(<TaskCard task={task({ metadata: { priority: priority as 'high' } })} onClick={vi.fn()} />);
      expect(screen.getByTestId('priority-chip')).toHaveClass('bg-destructive');
    });

    it.each(['medium', 'low'])('shows %s priority as plain muted text', (priority) => {
      render(<TaskCard task={task({ metadata: { priority: priority as 'low' } })} onClick={vi.fn()} />);
      expect(screen.queryByTestId('priority-chip')).toBeNull();
      expect(screen.getByTestId('priority-plain')).toHaveClass('text-muted-foreground');
    });

    it('puts the status chip first in the meta row, truncating, with the full text in title', () => {
      render(<TaskCard task={task({ status: 'human_review', reviewReason: 'qa_rejected', metadata: { priority: 'urgent' } })} onClick={vi.fn()} />);
      const meta = screen.getByTestId('task-meta-row');
      const chip = screen.getByTestId('status-chip');
      expect(meta.firstElementChild).toBe(chip);
      expect(chip).toHaveClass('max-w-full', 'min-w-0');
      expect(chip.querySelector('.truncate')).toBeInTheDocument();
      expect(chip).toHaveAttribute('title', 'reviewReason.qaIssues');
    });

    it('right-aligns a lone menu without a left border', () => {
      render(<TaskCard task={task({ status: 'queue' })} onClick={vi.fn()} onStatusChange={vi.fn()} />);
      const menu = screen.getByRole('button', { name: 'actions.taskActions' });
      expect(screen.getByTestId('task-action-strip').children).toHaveLength(1);
      expect(menu).toHaveClass('ml-auto');
      expect(menu).not.toHaveClass('border-l');
    });

    it('done task with a PR: icon button plus a labelled Archive', () => {
      render(<TaskCard task={task({ status: 'done', metadata: { prUrl: 'https://github.com/a/b/pull/1' } })} onClick={vi.fn()} />);
      const strip = screen.getByTestId('task-action-strip');
      expect(screen.getByRole('button', { name: 'tooltips.viewPR' })).toBeInTheDocument();
      const archive = screen.getByRole('button', { name: 'actions.archive' });
      expect(strip.contains(archive)).toBe(true);
      expect(archive.querySelector('span.truncate')).toHaveTextContent('actions.archive');
    });

    it('gives the primary action a title with its full label', () => {
      render(<TaskCard task={task()} onClick={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'actions.stop' })).toHaveAttribute('title', 'actions.stop');
    });

    it('clamps the title to three lines and keeps it in title', () => {
      render(<TaskCard task={task()} onClick={vi.fn()} />);
      const h = screen.getByRole('heading', { name: 'Build dashboard' });
      expect(h).toHaveClass('line-clamp-3');
      expect(h).toHaveAttribute('title', 'Build dashboard');
    });

    it('keeps only buttons in the strip, with a truncating primary label and a 44px menu', () => {
      render(<TaskCard task={task()} onClick={vi.fn()} onStatusChange={vi.fn()} />);
      const strip = screen.getByTestId('task-action-strip');
      const buttons = Array.from(strip.children);
      expect(buttons.every((el) => el.tagName === 'BUTTON')).toBe(true);
      const stop = screen.getByRole('button', { name: 'actions.stop' });
      expect(stop).toHaveClass('flex-1', 'min-w-0');
      expect(stop.querySelector('span.truncate')).toHaveTextContent('actions.stop');
      expect(screen.getByRole('button', { name: 'actions.taskActions' })).toHaveClass('w-11', 'border-l');
    });

    it('shows a CI result as its own row between body and strip', async () => {
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        openExternal: vi.fn(),
        deploy: { previewState: vi.fn(async () => ({ state: 'passed' })), onPreviewUpdate: vi.fn(() => () => undefined) },
      };
      render(<TaskCard task={task()} onClick={vi.fn()} onStatusChange={vi.fn()} />);
      const row = await screen.findByTestId('task-preview-row');
      const strip = screen.getByTestId('task-action-strip');
      expect(strip.contains(row)).toBe(false);
      expect(row.nextElementSibling).toBe(strip);
      expect(row).toHaveClass('min-h-11', 'w-full');
      expect(row.querySelector('span.truncate')).toHaveTextContent('taskCi.passed');
    });

    it('breathes while CI runs', async () => {
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        openExternal: vi.fn(),
        deploy: { previewState: vi.fn(async () => ({ state: 'running' })), onPreviewUpdate: vi.fn(() => () => undefined) },
      };
      render(<TaskCard task={task()} onClick={vi.fn()} />);
      expect(await screen.findByTestId('task-preview-mark')).toHaveClass('vt-breathe');
      const row = screen.getByTestId('task-preview-row');
      expect(row).toHaveAttribute('aria-busy', 'true');
      expect(row.querySelector('span.truncate')).toHaveTextContent('taskCi.running');
    });
  });

  describe('the CI row', () => {
    const withCi = (data: unknown) => {
      const openExternal = vi.fn();
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        openExternal,
        deploy: { previewState: vi.fn(async () => data), onPreviewUpdate: vi.fn(() => () => undefined) },
      };
      return openExternal;
    };
    afterEach(() => {
      cleanup();
      resetPreviewSubscription();
    });

    it.each([
      { state: 'not-set-up' },
      { state: 'not-pushed' },
      { state: 'waiting' },
      { state: 'unavailable', reason: 'push-off' },
      { state: 'unavailable', reason: 'public-repo' },
    ])('is absent for %o', async (data) => {
      withCi(data);
      render(<TaskCard task={task()} onClick={vi.fn()} />);
      await waitFor(() => expect(window.electronAPI.deploy.previewState).toHaveBeenCalled());
      expect(screen.queryByText(/taskCi\./)).not.toBeInTheDocument();
      expect(screen.queryByTestId('task-preview-row')).not.toBeInTheDocument();
    });

    it.each(['running', 'passed'])('%s is plain text, not a button, and a click opens nothing', async (state) => {
      const open = withCi({ state });
      const onClick = vi.fn();
      const heard = vi.fn();
      window.addEventListener('open-deploy', heard);
      render(<TaskCard task={task()} onClick={onClick} />);
      const row = await screen.findByTestId('task-preview-row');
      expect(row.tagName).not.toBe('BUTTON');
      expect(screen.queryByRole('button', { name: new RegExp(`taskCi\\.${state}`) })).not.toBeInTheDocument();
      expect(row).toHaveTextContent(`taskCi.${state}`);
      fireEvent.click(row);
      window.removeEventListener('open-deploy', heard);
      expect(open).not.toHaveBeenCalled();
      expect(heard).not.toHaveBeenCalled();
    });

    it.each([
      [{ state: 'failed', runId: 5, jobId: 9 }, { tab: 'runs', runId: 5, jobId: 9 }],
      [{ state: 'failed', runId: 5 }, { tab: 'runs', runId: 5 }],
    ])('failed goes to the failed run: %o', async (data, detail) => {
      withCi(data);
      const heard = vi.fn();
      window.addEventListener('open-deploy', heard);
      const onClick = vi.fn();
      render(<TaskCard task={task()} onClick={onClick} />);
      fireEvent.click(await screen.findByRole('button', { name: /taskCi\.failed/ }));
      window.removeEventListener('open-deploy', heard);
      expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual(detail);
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('delete from the card menu', () => {
    const openMenu = () => {
      const trigger = screen.getByRole('button', { name: 'actions.taskActions' });
      fireEvent.keyDown(trigger, { key: 'Enter' });
    };
    beforeEach(() => {
      deleteTask.mockClear();
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        checkWorktreeChanges: vi.fn(async () => ({ success: true, data: { hasChanges: true, changedFileCount: 2 } })),
      };
    });

    it('the menu offers Delete; it asks first, warns about uncommitted work, and deletes without opening the task', async () => {
      const onClick = vi.fn();
      render(<TaskCard task={task({ status: 'human_review' })} onClick={onClick} onStatusChange={vi.fn()} />);
      openMenu();
      fireEvent.click(await screen.findByRole('menuitem', { name: 'actions.delete' }));
      expect(await screen.findByText('tasks:deleteDialog.title')).toBeInTheDocument();
      expect(await screen.findByText(/tasks:deleteDialog\.uncommittedChanges {"count":2}/)).toBeInTheDocument();
      expect(deleteTask).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /tasks:deleteDialog\.deletePermanently/ }));
      await waitFor(() => expect(deleteTask).toHaveBeenCalledWith('task-a'));
      await waitFor(() => expect(screen.queryByText('tasks:deleteDialog.title')).not.toBeInTheDocument());
      expect(onClick).not.toHaveBeenCalled();
    });

    it('Cancel keeps the task', async () => {
      render(<TaskCard task={task({ status: 'backlog', executionProgress: undefined, subtasks: [] })} onClick={vi.fn()} onStatusChange={vi.fn()} />);
      openMenu();
      fireEvent.click(await screen.findByRole('menuitem', { name: 'actions.delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'tasks:deleteDialog.cancel' }));
      await waitFor(() => expect(screen.queryByText('tasks:deleteDialog.title')).not.toBeInTheDocument());
      expect(deleteTask).not.toHaveBeenCalled();
    });

    it('a running task cannot be deleted from the menu (stop it first)', async () => {
      render(<TaskCard task={task()} onClick={vi.fn()} onStatusChange={vi.fn()} />);
      openMenu();
      expect(await screen.findByRole('menuitem', { name: 'actions.delete' })).toHaveAttribute('data-disabled');
    });
  });
});
