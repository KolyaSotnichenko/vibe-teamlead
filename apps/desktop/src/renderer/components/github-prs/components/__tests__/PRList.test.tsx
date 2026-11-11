/**
 * @vitest-environment jsdom
 */
/** GitHub PRs list, in the same structure as GitHub Issues: left bar on the selected row, mono meta line. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PRData } from '../../hooks/useGitHubPRs';
import { formatRelative } from '../../../deploy/status';

const ui = vi.hoisted(() => ({ language: 'en' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: ui }),
}));

import { PRList } from '../PRList';

afterEach(() => {
  ui.language = 'en';
  cleanup();
});

const pr = (number: number, title: string): PRData => ({
  number, title, body: '', state: 'open', author: { login: 'kolya' }, headRefName: `feat-${number}`, baseRefName: 'main',
  additions: 10, deletions: 2, changedFiles: 1, assignees: [], files: [],
  createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z', htmlUrl: `https://github.com/acme/app/pull/${number}`,
});

describe('PRList', () => {
  it('marks the selected PR with a left bar and shows "#n · author · date" in mono', () => {
    const onSelectPR = vi.fn();
    render(
      <PRList
        prs={[pr(7, 'Add login'), pr(8, 'Fix logout')]}
        selectedPRNumber={7}
        isLoading={false}
        hasMore={false}
        error={null}
        getReviewStateForPR={() => null}
        onSelectPR={onSelectPR}
      />
    );
    const selected = screen.getByRole('button', { name: /Add login/ });
    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(selected).toHaveClass('border-l-foreground');
    const other = screen.getByRole('button', { name: /Fix logout/ });
    expect(other).not.toHaveAttribute('aria-current');
    expect(other).toHaveClass('border-l-transparent');
    expect(within(selected).getByText(/^#7 · kolya · /)).toHaveClass('font-mono');
    expect(within(selected).getByText(/^#7 · kolya · /).textContent).toBe(`#7 · kolya · ${formatRelative(pr(7, '').updatedAt, 'en')}`);
    expect(within(selected).getByText('feat-7')).toHaveClass('font-mono');
    fireEvent.click(other);
    expect(onSelectPR).toHaveBeenCalledWith(8);
  });

  it('says how long ago a PR changed in the UI language', () => {
    ui.language = 'uk';
    render(
      <PRList prs={[pr(7, 'Add login')]} selectedPRNumber={null} isLoading={false} hasMore={false} error={null}
        getReviewStateForPR={() => null} onSelectPR={vi.fn()} />
    );
    expect(screen.getByText(/^#7 · kolya · /).textContent).toBe(`#7 · kolya · ${formatRelative(pr(7, '').updatedAt, 'uk')}`);
  });
});
