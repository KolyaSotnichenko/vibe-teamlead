/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BetaUpdatesToggle } from '../BetaUpdatesToggle';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
afterEach(cleanup);

describe('BetaUpdatesToggle', () => {
  it("a pre-release shows it on and locked, and says why: it follows pre-releases whatever the setting says", () => {
    render(<BetaUpdatesToggle version="2.0.0-beta.2" enabled={false} onChange={vi.fn()} />);
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText('updates.betaUpdatesPrerelease')).toBeInTheDocument();
  });

  it('a stable version shows the setting and lets you change it', () => {
    const onChange = vi.fn();
    render(<BetaUpdatesToggle version="2.0.0" enabled={false} onChange={onChange} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(screen.getByText('updates.betaUpdatesDescription')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('before the version is known, it stays the plain setting', () => {
    render(<BetaUpdatesToggle version="" enabled={true} onChange={vi.fn()} />);
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByRole('switch')).toBeEnabled();
  });
});
