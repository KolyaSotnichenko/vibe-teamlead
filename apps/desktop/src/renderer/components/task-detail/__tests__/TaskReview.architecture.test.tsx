/**
 * @vitest-environment jsdom
 */
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Task } from '../../../../shared/types';

vi.mock('../task-review', () => {
  const stub = (name: string) => () => <div>{name}</div>;
  const none = () => null;
  return {
    WorkspaceStatus: stub('workspace'),
    QAFeedbackSection: stub('feedback'),
    NoWorkspaceMessage: stub('no-workspace'),
    LoadingMessage: none,
    StagedSuccessMessage: none,
    StagedInProjectMessage: none,
    DiscardDialog: none,
    DiffViewDialog: none,
    ConflictDetailsDialog: none,
    CreatePRDialog: none,
    WorkspaceMessages: none,
  };
});
vi.mock('../task-review/QaOutcomePanel', () => ({ QaOutcomePanel: () => <div>qa-outcome</div> }));
vi.mock('../task-review/MergeReviewPanel', () => ({ MergeReviewPanel: () => null }));
vi.mock('../../../stores/task-store', async () => {
  const actual = await vi.importActual<typeof import('../../../stores/task-store')>('../../../stores/task-store');
  return { hasNothingBuilt: actual.hasNothingBuilt };
});

import { TaskReview } from '../TaskReview';

afterEach(cleanup);

describe('TaskReview of an architecture-only task', () => {
  it('offers only closing it: no QA outcome, no change request, nothing to merge', () => {
    const task = { id: 't', status: 'human_review', reviewReason: 'architecture_ready', subtasks: [] } as unknown as Task;
    render(<TaskReview {...({ task, worktreeStatus: null, isLoadingWorktree: false } as unknown as ComponentProps<typeof TaskReview>)} />);
    expect(screen.getByText('no-workspace')).toBeInTheDocument();
    expect(screen.queryByText('qa-outcome')).not.toBeInTheDocument();
    expect(screen.queryByText('feedback')).not.toBeInTheDocument();
  });
});
