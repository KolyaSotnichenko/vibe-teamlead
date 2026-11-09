/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key) }),
}));

import { gaveUpSubtasks, TaskWarnings } from '../TaskWarnings';

const base = {
  isStuck: false,
  isIncomplete: true,
  isRecovering: false,
  taskProgress: { completed: 12, total: 13 },
  onRecover: vi.fn(),
  onResume: vi.fn(),
};
const gaveUp = [{ id: 'subtask-6-1', title: 'Run full suite twice', notes: 'Full suite red on specs from task 022. Needs a product fix.' }];

afterEach(cleanup);

describe('TaskWarnings for a subtask the coder gave up on', () => {
  it("shows the coder's reason and offers to go on without it or send it back, not a plain Resume", () => {
    const onSkip = vi.fn();
    render(<TaskWarnings {...base} gaveUp={gaveUp} onSkipFailed={onSkip} onRetryFailed={vi.fn()} />);
    expect(screen.getByText('taskDetail.warnings.gaveUpTitle {"title":"Run full suite twice"}')).toBeInTheDocument();
    expect(screen.getByText(/Full suite red on specs from task 022/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'taskDetail.resume' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'taskDetail.warnings.skipFailed' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('sends it back with what the owner typed, and only once something is typed', () => {
    const onRetry = vi.fn();
    render(<TaskWarnings {...base} gaveUp={gaveUp} onSkipFailed={vi.fn()} onRetryFailed={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'taskDetail.warnings.retryFailed' }));
    const send = screen.getByRole('button', { name: 'taskDetail.warnings.sendBack' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('taskDetail.warnings.instructionLabel'), { target: { value: 'You may change product code.' } });
    fireEvent.click(send);
    expect(onRetry).toHaveBeenCalledWith('You may change product code.');
  });

  it('says when the coder wrote no reason', () => {
    render(<TaskWarnings {...base} gaveUp={[{ id: 's1', title: 'X' }]} onSkipFailed={vi.fn()} onRetryFailed={vi.fn()} />);
    expect(screen.getByText('taskDetail.warnings.noReason')).toBeInTheDocument();
  });

  it('keeps the plain Resume when no subtask was given up on', () => {
    const onResume = vi.fn();
    render(<TaskWarnings {...base} onResume={onResume} gaveUp={[]} onSkipFailed={vi.fn()} onRetryFailed={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'taskDetail.resume' }));
    expect(onResume).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'taskDetail.warnings.skipFailed' })).not.toBeInTheDocument();
  });
});

describe('gaveUpSubtasks', () => {
  it('picks the failed and blocked ones with their notes', () => {
    expect(
      gaveUpSubtasks([
        { id: 'a', title: 'A', status: 'completed' },
        { id: 'b', title: 'B', status: 'failed', notes: 'why' },
        { id: 'c', title: 'C', status: 'blocked' },
        { id: 'd', title: 'D', status: 'pending' },
      ]),
    ).toEqual([{ id: 'b', title: 'B', notes: 'why' }, { id: 'c', title: 'C', notes: undefined }]);
  });
});
