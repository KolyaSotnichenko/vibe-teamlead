/**
 * @vitest-environment jsdom
 */
/** GitLab Issues in the same structure as GitHub Issues (segmented filter, left-bar rows, mono meta, one primary action). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { GitLabIssue } from '../../../../../shared/types';
import { formatDate } from '../../../../lib/format-date';

const ui = vi.hoisted(() => ({ language: 'en' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: ui }),
}));

import { IssueListHeader } from '../IssueListHeader';
import { IssueListItem } from '../IssueListItem';
import { IssueDetail } from '../IssueDetail';

afterEach(() => {
  ui.language = 'en';
  cleanup();
  vi.clearAllMocks();
});

const issue: GitLabIssue = {
  id: 1, iid: 12, title: 'Signup confirms the address', description: 'Body', state: 'opened', labels: [], assignees: [],
  author: { username: 'kolya' }, createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z', userNotesCount: 0,
  webUrl: 'https://gitlab.com/acme/app/-/issues/12', projectPathWithNamespace: 'acme/app',
};

describe('GitLab Issues', () => {
  it('filters with a segmented Open / Closed / All control and shows the count as text', () => {
    const onFilterChange = vi.fn();
    const onRefresh = vi.fn();
    render(
      <IssueListHeader projectPath="acme/app" openIssuesCount={3} isLoading={false} searchQuery="" filterState="opened"
        onSearchChange={vi.fn()} onFilterChange={onFilterChange} onRefresh={onRefresh} />
    );
    expect(screen.getByText('acme/app')).toHaveClass('font-mono');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const group = screen.getByRole('radiogroup', { name: 'header.filterLabel' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['filters.opened', 'filters.closed', 'filters.all']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radios[1]);
    expect(onFilterChange).toHaveBeenCalledWith('closed');
    fireEvent.click(screen.getByRole('button', { name: 'common:buttons.refresh' }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('marks the selected row with a left bar and a mono "#n · author · date" line', () => {
    render(<ul><IssueListItem issue={issue} isSelected onClick={vi.fn()} onInvestigate={vi.fn()} /></ul>);
    const row = screen.getByRole('button', { name: /Signup confirms the address/ });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveClass('border-l-foreground');
    expect(within(row).getByText(`#12 · kolya · ${formatDate(issue.createdAt, 'en')}`)).toHaveClass('font-mono');
  });

  it('dates rows in the UI language', () => {
    ui.language = 'uk';
    render(<ul><IssueListItem issue={issue} isSelected={false} onClick={vi.fn()} onInvestigate={vi.fn()} /></ul>);
    expect(screen.getByText(`#12 · kolya · ${formatDate(issue.createdAt, 'uk')}`)).toBeInTheDocument();
  });

  it('shows one primary Create task and a small-caps Description label', () => {
    const onInvestigate = vi.fn();
    render(<IssueDetail issue={issue} onInvestigate={onInvestigate} investigationResult={null} />);
    expect(screen.getByRole('heading', { name: 'Signup confirms the address' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'common:accessibility.openOnGitLabAriaLabel' })).toHaveAttribute('href', issue.webUrl);
    expect(screen.getByText('states.opened')).toHaveClass('font-mono', 'uppercase');
    const create = screen.getByRole('button', { name: 'detail.createTask' });
    expect(create).not.toHaveClass('flex-1');
    fireEvent.click(create);
    expect(onInvestigate).toHaveBeenCalled();
    expect(screen.getByText('detail.description')).toHaveClass('font-mono', 'uppercase');
  });
});
