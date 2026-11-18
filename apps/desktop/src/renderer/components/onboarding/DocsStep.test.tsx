/**
 * @vitest-environment jsdom
 */
/**
 * The wizard asks the user to read the documentation before starting work: it says what
 * the docs cover, opens them in place, and goes on only once the user confirms.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../docs/DocsView', () => ({ DocsView: () => <div>docs-view</div> }));

import { DocsStep } from './DocsStep';

describe('DocsStep', () => {
  const onNext = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('says reading the docs is required and what they cover', () => {
    render(<DocsStep onNext={onNext} onBack={onBack} />);
    expect(screen.getByText('docs.title')).toBeInTheDocument();
    expect(screen.getByText('docs.required')).toBeInTheDocument();
    for (const item of ['pipeline', 'agents', 'preview', 'settings', 'costs']) {
      expect(screen.getByText(`docs.covers.${item}`)).toBeInTheDocument();
    }
  });

  it("can't continue until the checkbox is ticked", () => {
    render(<DocsStep onNext={onNext} onBack={onBack} />);
    const cont = screen.getByRole('button', { name: 'docs.continue' });
    expect(cont).toBeDisabled();
    fireEvent.click(cont);
    expect(onNext).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'docs.acknowledge' }));
    expect(cont).not.toBeDisabled();
    fireEvent.click(cont);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('opens the Documentation page in place', () => {
    render(<DocsStep onNext={onNext} onBack={onBack} />);
    expect(screen.queryByText('docs-view')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /docs\.open/ }));
    expect(screen.getByText('docs-view')).toBeInTheDocument();
  });

  it('goes back', () => {
    render(<DocsStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'docs.back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
