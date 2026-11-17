/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

import { PreviewToolbar } from '../PreviewToolbar';

afterEach(cleanup);

describe('PreviewToolbar', () => {
  it('resets the session (signs out of the previewed app) without a confirmation', () => {
    const onNavigate = vi.fn();
    render(<PreviewToolbar url="http://localhost:4100/" width={null} onWidth={vi.fn()} onNavigate={onNavigate} onReset={vi.fn()} onEditServices={vi.fn()} disabled={false} side={null} onSide={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'preview.toolbar.signOut' }));
    expect(onNavigate).toHaveBeenCalledWith({ action: 'signOut' });
  });

  it('has a "How to run" button only when the project has RUNNING.md', () => {
    const onSide = vi.fn();
    const props = { width: null, onWidth: vi.fn(), onNavigate: vi.fn(), onReset: vi.fn(), onEditServices: vi.fn(), disabled: true, side: null, onSide };
    const { rerender } = render(<PreviewToolbar {...props} />);
    expect(screen.queryByRole('button', { name: 'preview.toolbar.running' })).not.toBeInTheDocument();
    rerender(<PreviewToolbar {...props} howToRun />);
    fireEvent.click(screen.getByRole('button', { name: 'preview.toolbar.running' }));
    expect(onSide).toHaveBeenCalledWith('running');
  });
});
