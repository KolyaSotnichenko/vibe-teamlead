/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TooltipProvider } from '../../../ui/tooltip';
import type { WorktreeStatus } from '../../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../../../../hooks/useGitHubRemote', () => ({ useGitHubRemote: () => false }));

import { WorkspaceStatus } from '../WorkspaceStatus';

afterEach(cleanup);

const worktree = { exists: true, branch: 'b', baseBranch: 'main', commitCount: 1, filesChanged: 1, additions: 1, deletions: 1, worktreePath: '/wt' } as unknown as WorktreeStatus;
const preview = { files: ['a.ts'], conflicts: [], summary: { totalFiles: 1, conflictFiles: 0, totalConflicts: 0, autoMergeable: 0 } } as never;

const show = (mergeReviewOpen: boolean) => render(
  <TooltipProvider>
    <WorkspaceStatus
      taskId="t1"
      worktreeStatus={worktree}
      workspaceError={null}
      stageOnly={false}
      mergePreview={preview}
      isLoadingPreview={false}
      isMerging={false}
      isDiscarding={false}
      mergeReviewOpen={mergeReviewOpen}
      onShowDiffDialog={vi.fn()}
      onShowDiscardDialog={vi.fn()}
      onShowConflictDialog={vi.fn()}
      onLoadMergePreview={vi.fn()}
      onStageOnlyChange={vi.fn()}
      onMerge={vi.fn()}
    />
  </TooltipProvider>,
);

describe('WorkspaceStatus while a merge waits for review', () => {
  it('has no second way to merge: the review above decides', () => {
    show(true);
    expect(screen.queryByText('taskReview:merge.status.stageOnly')).not.toBeInTheDocument();
    expect(screen.queryByText('taskReview:merge.status.readyToMerge')).not.toBeInTheDocument();
    expect(screen.queryByText(/merge\.buttons/)).not.toBeInTheDocument();
  });

  it('keeps the way to the code: the review asks you to read it and allows editing it', () => {
    show(true);
    expect(screen.getByText(/worktreePath|\/wt/)).toBeInTheDocument();
  });

  it('shows the merge actions otherwise', () => {
    show(false);
    expect(screen.getByText('taskReview:merge.status.stageOnly')).toBeInTheDocument();
  });
});
