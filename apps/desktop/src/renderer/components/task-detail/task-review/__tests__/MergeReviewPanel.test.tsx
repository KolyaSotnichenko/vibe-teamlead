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

import { diffLines, MergeReviewPanel } from '../MergeReviewPanel';

const task = { id: 't1', projectId: 'p1', title: 'Auth', status: 'human_review' } as unknown as Task;

const DIFF = 'diff --git a/src/auth.ts b/src/auth.ts\nindex 1..2 100644\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old line\n+new line\n';

function setup(files: string[] | undefined, merge: unknown = { success: true, data: { success: true, message: 'ok' } }, diff: unknown = { success: true, data: { diff: DIFF, truncated: false } }) {
  const getMergeReviewDiff = vi.fn(async () => diff);
  const mergeWorktree = vi.fn(async () => merge);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getTaskWorkspace: vi.fn(async () => ({ success: true, data: files ? { mergeReview: { files } } : {} })),
    mergeWorktree,
    getMergeReviewDiff,
  };
  const onMerged = vi.fn();
  const view = render(<MergeReviewPanel task={task} onMerged={onMerged} />);
  return { getMergeReviewDiff, mergeWorktree, onMerged, view };
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

  it('opens a file to show what changes in the project, then how it differs from the task', async () => {
    const { getMergeReviewDiff } = setup(['src/auth.ts']);
    const file = await screen.findByRole('button', { name: 'src/auth.ts' });
    expect(getMergeReviewDiff).not.toHaveBeenCalled();
    expect(file).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(file);

    expect(await screen.findByText('new line')).toBeInTheDocument();
    expect(screen.getByText('old line')).toBeInTheDocument();
    expect(file).toHaveAttribute('aria-expanded', 'true');
    expect(getMergeReviewDiff).toHaveBeenLastCalledWith('t1', 'src/auth.ts', 'project', 'p1');
    expect(screen.queryByText(/index 1\.\.2/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mergeReview.againstTask' }));
    await waitFor(() => expect(getMergeReviewDiff).toHaveBeenLastCalledWith('t1', 'src/auth.ts', 'task', 'p1'));

    fireEvent.click(file);
    expect(screen.queryByText('new line')).not.toBeInTheDocument();
  });

  it('says when a diff was cut, when there is no difference, and when it could not load', async () => {
    setup(['a.ts'], undefined, { success: true, data: { diff: DIFF, truncated: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
    expect(await screen.findByText('mergeReview.truncated')).toBeInTheDocument();
    cleanup();

    setup(['a.ts'], undefined, { success: true, data: { diff: '', truncated: false } });
    fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
    expect(await screen.findByText('mergeReview.noDifference')).toBeInTheDocument();
    cleanup();

    setup(['a.ts'], undefined, { success: false, error: 'boom' });
    fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
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

  it('reads a unified diff into lines, without its headers', () => {
    expect(diffLines(DIFF)).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'removed', text: 'old line' },
      { kind: 'added', text: 'new line' },
    ]);
    expect(diffLines('@@ -1 +1 @@\n context\n--- not a header\n+++ neither\n').map((l) => l.kind)).toEqual(['hunk', 'context', 'removed', 'added']);
  });
});
