/**
 * @vitest-environment jsdom
 */
/**
 * GitHub Issues, restyled (owner-approved mockup): header with plain open count, auto-fix switch,
 * a normal-size "Analyze & group" and a ghost refresh; toolbar with search and an Open / Closed / All
 * segmented filter; list rows with a left bar for the selection and a mono meta line; the detail with
 * one primary "Create task" under the meta and small-caps "Description".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { GitHubIssue } from '../../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${key} ${o.count}` : key),
    i18n: { language: 'en' },
  }),
}));

import { IssueListHeader } from '../IssueListHeader';
import { IssueListItem } from '../IssueListItem';
import { IssueDetail } from '../IssueDetail';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const issue: GitHubIssue = {
  id: 1, number: 4, title: 'Check the connection message', body: 'Body **text**', state: 'open',
  labels: [], assignees: [], author: { login: 'kolya' }, createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z',
  commentsCount: 0, url: 'https://api.github.com/repos/acme/app/issues/4', htmlUrl: 'https://github.com/acme/app/issues/4', repoFullName: 'acme/app',
};

function header(over: Partial<Parameters<typeof IssueListHeader>[0]> = {}) {
  const props = {
    repoFullName: 'acme/app', openIssuesCount: 2, isLoading: false, searchQuery: '', filterState: 'open' as const,
    onSearchChange: vi.fn(), onFilterChange: vi.fn(), onRefresh: vi.fn(),
    autoFixEnabled: false, onAutoFixToggle: vi.fn(), onAnalyzeAndGroup: vi.fn(), isAnalyzing: false, ...over,
  };
  render(<IssueListHeader {...props} />);
  return props;
}

describe('GitHub Issues header', () => {
  it('shows the title, the repo in mono, and the open count as plain text', () => {
    header();
    expect(screen.getByRole('heading', { name: 'issues.header.title' })).toBeInTheDocument();
    expect(screen.getByText('acme/app')).toHaveClass('font-mono');
    const count = screen.getByText('issues.header.openCount 2');
    expect(count.tagName).toBe('SPAN');
    expect(count).toHaveClass('font-mono');
  });

  it('filters by state with a segmented Open / Closed / All control instead of a dropdown', () => {
    const props = header({ filterState: 'open' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const group = screen.getByRole('radiogroup', { name: 'issues.header.filterLabel' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['issues.header.filterOpen', 'issues.header.filterClosed', 'issues.header.filterAll']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radios[1]);
    expect(props.onFilterChange).toHaveBeenCalledWith('closed');
    fireEvent.click(radios[2]);
    expect(props.onFilterChange).toHaveBeenCalledWith('all');
  });

  it('searches as you type', () => {
    const props = header();
    fireEvent.change(screen.getByPlaceholderText('issues.header.searchPlaceholder'), { target: { value: 'login' } });
    expect(props.onSearchChange).toHaveBeenCalledWith('login');
  });

  it('keeps auto-fix as a switch, analyze as a normal-size outline button, and refresh as a ghost icon', () => {
    const props = header();
    const toggle = screen.getByRole('switch', { name: 'issues.header.autoFixNew' });
    fireEvent.click(toggle);
    expect(props.onAutoFixToggle).toHaveBeenCalledWith(true);
    const analyze = screen.getByRole('button', { name: 'issues.batchReview.title' });
    expect(analyze).not.toHaveClass('flex-1', 'w-full');
    expect(analyze).toHaveClass('h-10', 'border-foreground');
    fireEvent.click(analyze);
    expect(props.onAnalyzeAndGroup).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'buttons.refresh' }));
    expect(props.onRefresh).toHaveBeenCalled();
  });
});

describe('GitHub Issues list row', () => {
  it('marks the selected issue with a left bar and shows "#n · author · date" in mono', () => {
    const onClick = vi.fn();
    render(
      <ul>
        <IssueListItem issue={issue} isSelected onClick={onClick} onInvestigate={vi.fn()} />
        <IssueListItem issue={{ ...issue, id: 2, number: 3, title: 'Other' }} isSelected={false} onClick={vi.fn()} onInvestigate={vi.fn()} />
      </ul>
    );
    const selected = screen.getByRole('button', { name: /Check the connection message/ });
    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(selected).toHaveClass('border-l-foreground');
    const other = screen.getByRole('button', { name: /Other/ });
    expect(other).not.toHaveAttribute('aria-current');
    expect(other).toHaveClass('border-l-transparent');
    const meta = within(selected).getByText(/^#4 · kolya · /);
    expect(meta).toHaveClass('font-mono');
    expect(meta.textContent).toBe('#4 · kolya · Sep 30, 2026');
    fireEvent.click(selected);
    expect(onClick).toHaveBeenCalled();
  });
});

describe('GitHub Issues detail', () => {
  it('shows the title with an external link, state and meta, one primary Create task, and a Description label', () => {
    const onInvestigate = vi.fn();
    render(<IssueDetail issue={issue} onInvestigate={onInvestigate} investigationResult={null} />);
    expect(screen.getByRole('heading', { name: 'Check the connection message' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'accessibility.openOnGitHubAriaLabel' });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/issues/4');
    expect(screen.getByText('prReview.state.open')).toHaveClass('font-mono', 'uppercase');
    expect(screen.getByText('#4 · kolya · Sep 30, 2026')).toHaveClass('font-mono');
    const create = screen.getByRole('button', { name: 'insights.createTask' });
    expect(create).toHaveClass('bg-primary', 'h-10');
    expect(create).not.toHaveClass('flex-1');
    fireEvent.click(create);
    expect(onInvestigate).toHaveBeenCalled();
    expect(screen.getByText('prReview.description')).toHaveClass('font-mono', 'uppercase');
    expect(screen.getByText('text')).toBeInTheDocument();
  });

  it('offers View task instead of Create task once a task is linked', () => {
    const onViewTask = vi.fn();
    render(<IssueDetail issue={issue} onInvestigate={vi.fn()} investigationResult={null} linkedTaskId="042-fix" onViewTask={onViewTask} />);
    expect(screen.queryByRole('button', { name: 'insights.createTask' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'roadmap.viewTask' }));
    expect(onViewTask).toHaveBeenCalledWith('042-fix');
  });
});
