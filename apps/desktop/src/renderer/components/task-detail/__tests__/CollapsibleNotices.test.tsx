/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { CollapsibleNotices } from '../CollapsibleNotices';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const Notice = ({ title }: { title: string }) => (
  <section>
    <h3>{title}</h3>
    <p>details of {title}</p>
  </section>
);

describe('CollapsibleNotices', () => {
  it('folds to one line with the notices\' titles, unfolds, and remembers the choice', async () => {
    const { unmount } = render(
      <CollapsibleNotices>
        <Notice title="Check 2 screens before merging" />
        <Notice title="CI failed" />
      </CollapsibleNotices>,
    );
    expect(screen.getByText('details of CI failed')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'taskNotices.hide' }));
    await waitFor(() => expect(screen.getByText('details of CI failed')).not.toBeVisible());
    expect(screen.getByText('Check 2 screens before merging · CI failed')).toBeInTheDocument();

    unmount();
    render(
      <CollapsibleNotices>
        <Notice title="CI failed" />
      </CollapsibleNotices>,
    );
    expect(screen.getByText('details of CI failed')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'taskNotices.show' }));
    expect(screen.getByText('details of CI failed')).toBeVisible();
  });

  it('shows nothing at all when there are no notices', async () => {
    const Nothing = () => null;
    render(
      <CollapsibleNotices>
        <Nothing />
      </CollapsibleNotices>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
