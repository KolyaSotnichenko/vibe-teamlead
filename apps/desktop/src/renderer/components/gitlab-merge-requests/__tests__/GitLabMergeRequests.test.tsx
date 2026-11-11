/**
 * @vitest-environment jsdom
 */
/**
 * GitLab MRs in the same structure as the Issues pages: header with a normal-size "New merge request"
 * and a ghost refresh (no full-width button), toolbar with search and a segmented state filter,
 * list rows with a left bar and a mono meta line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { GitLabMergeRequest } from '../../../../shared/types';
import { formatDate } from '../../../lib/format-date';

const ui = vi.hoisted(() => ({ language: 'en' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key), i18n: ui }),
}));

const hook = vi.hoisted(() => ({ calls: [] as Array<{ stateFilter: string }>, refresh: vi.fn(), selectMR: vi.fn() }));
const mrs: GitLabMergeRequest[] = [
  { id: 1, iid: 5, title: 'Add billing', state: 'opened', sourceBranch: 'billing', targetBranch: 'main', author: { username: 'kolya' },
    assignees: [], labels: [], webUrl: 'https://gitlab.com/acme/app/-/merge_requests/5', createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z', mergeStatus: 'can_be_merged' },
  { id: 2, iid: 6, title: 'Fix login', state: 'opened', sourceBranch: 'login', targetBranch: 'main', author: { username: 'ann' },
    assignees: [], labels: [], webUrl: 'https://gitlab.com/acme/app/-/merge_requests/6', createdAt: '2026-09-29T10:00:00Z', updatedAt: '2026-09-29T10:00:00Z', mergeStatus: 'can_be_merged' },
];
vi.mock('../hooks/useGitLabMRs', () => ({
  useGitLabMRs: (_projectId: string, options: { stateFilter: string }) => {
    hook.calls.push(options);
    return {
      mergeRequests: mrs, isLoading: false, error: null, selectedMR: mrs[0], selectedMRIid: 5,
      reviewResult: null, reviewProgress: null, isReviewing: false, selectMR: hook.selectMR, refresh: hook.refresh,
      runReview: vi.fn(), runFollowupReview: vi.fn(), checkNewCommits: vi.fn(), cancelReview: vi.fn(), postReview: vi.fn(),
      postNote: vi.fn(), mergeMR: vi.fn(), assignMR: vi.fn(), approveMR: vi.fn(),
    };
  },
}));
vi.mock('../components/MRDetail', () => ({ MRDetail: () => <div>mr-detail</div> }));
vi.mock('../components/CreateMergeRequestDialog', () => ({
  CreateMergeRequestDialog: ({ open }: { open: boolean }) => (open ? <div>create-dialog</div> : null),
}));
vi.mock('../../../stores/gitlab', () => ({ initializeMRReviewListeners: vi.fn() }));

import { GitLabMergeRequests } from '../GitLabMergeRequests';

beforeEach(() => {
  hook.calls.length = 0;
});
afterEach(() => {
  ui.language = 'en';
  cleanup();
  vi.clearAllMocks();
});

describe('GitLabMergeRequests', () => {
  it('has a header with a normal-size New merge request and a ghost refresh', () => {
    render(<GitLabMergeRequests projectId="p1" />);
    expect(screen.getByRole('heading', { name: 'mergeRequests.title' })).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'mergeRequests.newMR' });
    expect(create).not.toHaveClass('w-full');
    fireEvent.click(create);
    expect(screen.getByText('create-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common:buttons.refresh' }));
    expect(hook.refresh).toHaveBeenCalled();
  });

  it('filters by state with a segmented control and searches the list', () => {
    render(<GitLabMergeRequests projectId="p1" />);
    const group = screen.getByRole('radiogroup', { name: 'mergeRequests.filterLabel' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'mergeRequests.filters.opened', 'mergeRequests.filters.merged', 'mergeRequests.filters.closed', 'mergeRequests.filters.all',
    ]);
    fireEvent.click(radios[1]);
    expect(hook.calls[hook.calls.length - 1].stateFilter).toBe('merged');
    fireEvent.change(screen.getByPlaceholderText('mergeRequests.searchPlaceholder'), { target: { value: 'login' } });
    expect(screen.queryByRole('button', { name: /Add billing/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fix login/ })).toBeInTheDocument();
  });

  it('marks the selected MR with a left bar and a mono "!n · author · date" line', () => {
    render(<GitLabMergeRequests projectId="p1" />);
    const row = screen.getByRole('button', { name: /Add billing/ });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveClass('border-l-foreground');
    expect(within(row).getByText(`!5 · kolya · ${formatDate(mrs[0].createdAt, 'en')}`)).toHaveClass('font-mono');
    expect(within(row).getByText('billing → main')).toHaveClass('font-mono');
    const other = screen.getByRole('button', { name: /Fix login/ });
    expect(other).toHaveClass('border-l-transparent');
    fireEvent.click(other);
    expect(hook.selectMR).toHaveBeenCalledWith(6);
  });

  it('dates rows in the UI language', () => {
    ui.language = 'uk';
    render(<GitLabMergeRequests projectId="p1" />);
    expect(screen.getByText(`!5 · kolya · ${formatDate(mrs[0].createdAt, 'uk')}`)).toBeInTheDocument();
  });
});
