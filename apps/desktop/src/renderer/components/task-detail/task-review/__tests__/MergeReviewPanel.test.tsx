/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key) }),
}));

import { MergeReviewPanel } from '../MergeReviewPanel';

const task = { id: 't1', projectId: 'p1', title: 'Auth', status: 'human_review' } as unknown as Task;

function setup(files: string[] | undefined, merge: unknown = { success: true, data: { success: true, message: 'ok' } }) {
  const mergeWorktree = vi.fn(async () => merge);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getTaskWorkspace: vi.fn(async () => ({ success: true, data: files ? { mergeReview: { files } } : {} })),
    mergeWorktree,
  };
  const onMerged = vi.fn();
  const view = render(<MergeReviewPanel task={task} onMerged={onMerged} />);
  return { mergeWorktree, onMerged, view };
}

afterEach(cleanup);

describe('MergeReviewPanel', () => {
  it('shows nothing when no merge waits for review', async () => {
    const { view } = setup(undefined);
    await waitFor(() => expect(window.electronAPI.getTaskWorkspace).toHaveBeenCalled());
    expect(view.container).toBeEmptyDOMElement();
  });

  it('lists the files the model wrote and commits on confirm', async () => {
    const { mergeWorktree, onMerged } = setup(['src/auth.ts', 'src/app.ts']);
    expect(await screen.findByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'mergeReview.commit' }));
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
    expect(mergeWorktree).toHaveBeenCalledWith('t1', { reviewAction: 'commit' });
  });

  it('cancels and disappears without closing the task', async () => {
    const { mergeWorktree, onMerged } = setup(['src/auth.ts']);
    fireEvent.click(await screen.findByRole('button', { name: 'mergeReview.cancel' }));
    await waitFor(() => expect(screen.queryByText('src/auth.ts')).not.toBeInTheDocument());
    expect(mergeWorktree).toHaveBeenCalledWith('t1', { reviewAction: 'cancel' });
    expect(onMerged).not.toHaveBeenCalled();
  });

  it('keeps the review open and says why when the commit fails', async () => {
    const { onMerged } = setup(['src/auth.ts'], { success: true, data: { success: false, message: 'identity unknown' } });
    fireEvent.click(await screen.findByRole('button', { name: 'mergeReview.commit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('identity unknown');
    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
    expect(onMerged).not.toHaveBeenCalled();
  });
});
