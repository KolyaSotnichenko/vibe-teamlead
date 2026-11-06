/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergeProgress, MergeState, Task } from '../../../../shared/types';
import { MergeStateNotice } from '../MergeStateNotice';
import { resetMergeStateSubscription } from '../useMergeState';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const task = { id: 't1', projectId: 'p1', status: 'human_review' } as unknown as Task;
let listeners: ((taskId: string, progress: MergeProgress) => void)[] = [];
const getTaskMergeState = vi.fn();

const answers = (state: MergeState | null) => getTaskMergeState.mockResolvedValue({ success: true, data: state });
const progress = (taskId: string, stage: string) => {
  for (const listener of listeners) listener(taskId, { stage, percent: 0, message: '' } as MergeProgress);
};

beforeEach(() => {
  listeners = [];
  resetMergeStateSubscription();
  getTaskMergeState.mockReset();
  answers(null);
  Object.assign(window, {
    electronAPI: {
      getTaskMergeState,
      onMergeProgress: (listener: (taskId: string, progress: MergeProgress) => void) => {
        listeners.push(listener);
        return () => { listeners = listeners.filter((other) => other !== listener); };
      },
    },
  });
});

afterEach(cleanup);

describe('MergeStateNotice', () => {
  it('shows nothing when there is nothing to say', async () => {
    const { container } = render(<MergeStateNotice task={task} />);
    await waitFor(() => expect(getTaskMergeState).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows why a merge failed, reopened after the window was closed', async () => {
    answers({ state: 'failed', reason: 'the tasks disagree' });
    render(<MergeStateNotice task={task} />);
    expect(await screen.findByText('the tasks disagree')).toBeInTheDocument();
    expect(screen.getByText('mergeState.failedTitle')).toBeInTheDocument();
  });

  it('says a merge is on, as soon as it hears of one', async () => {
    render(<MergeStateNotice task={task} />);
    await waitFor(() => expect(getTaskMergeState).toHaveBeenCalled());
    progress('t1', 'analyzing');
    expect(await screen.findByText('mergeState.mergingTitle')).toBeInTheDocument();
  });

  it("isn't moved by another task's merge", async () => {
    const { container } = render(<MergeStateNotice task={task} />);
    await waitFor(() => expect(getTaskMergeState).toHaveBeenCalled());
    progress('other', 'analyzing');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(container).toBeEmptyDOMElement();
  });

  it('asks again when the merge ends', async () => {
    render(<MergeStateNotice task={task} />);
    await waitFor(() => expect(getTaskMergeState).toHaveBeenCalledTimes(1));
    progress('t1', 'analyzing');
    answers({ state: 'failed', reason: 'it broke' });
    progress('t1', 'error');
    expect(await screen.findByText('it broke')).toBeInTheDocument();
  });

  it('leaves a review to its own panel', async () => {
    answers({ state: 'review' });
    const { container } = render(<MergeStateNotice task={task} />);
    await waitFor(() => expect(getTaskMergeState).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(container).toBeEmptyDOMElement();
  });

  it('asks nothing for a task not in review', async () => {
    render(<MergeStateNotice task={{ ...task, status: 'in_progress' } as Task} />);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(getTaskMergeState).not.toHaveBeenCalled();
  });

  it('many cards share one listener: there can be dozens on a board', async () => {
    render(<><MergeStateNotice task={task} /><MergeStateNotice task={{ ...task, id: 't2' } as Task} /></>);
    await waitFor(() => expect(getTaskMergeState).toHaveBeenCalledTimes(2));
    expect(listeners).toHaveLength(1);
  });
});
