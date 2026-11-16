/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key) }),
}));

import { MergeWaitingDialog } from '../MergeWaitingDialog';

afterEach(cleanup);

const tasks = [
  { id: 'a', title: 'Sign in with Entra ID' },
  { id: 'b', title: 'App shell' },
] as never[];

describe('MergeWaitingDialog', () => {
  it('names the tasks that already wait and merges them only on yes', () => {
    const onMerge = vi.fn();
    const onClose = vi.fn();
    render(<MergeWaitingDialog tasks={tasks} onMerge={onMerge} onClose={onClose} />);
    expect(screen.getByText('queue.mergeWaiting.title {"count":2}')).toBeInTheDocument();
    expect(screen.getByText('Sign in with Entra ID')).toBeInTheDocument();
    expect(screen.getByText('App shell')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'queue.mergeWaiting.merge {"count":2}' }));
    expect(onMerge).toHaveBeenCalledWith(tasks);
  });

  it('leaves them waiting on not now', () => {
    const onMerge = vi.fn();
    const onClose = vi.fn();
    render(<MergeWaitingDialog tasks={tasks} onMerge={onMerge} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'queue.mergeWaiting.notNow' }));
    expect(onMerge).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows nothing when no task waits', () => {
    const { container } = render(<MergeWaitingDialog tasks={[]} onMerge={vi.fn()} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
