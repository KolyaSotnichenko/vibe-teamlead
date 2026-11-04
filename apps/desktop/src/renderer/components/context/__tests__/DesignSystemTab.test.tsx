/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../../stores/project-store', () => ({ loadProjects: vi.fn(async () => {}) }));

import { designMock } from '../../../lib/mocks/design-mock';
import { DesignSystemTab } from '../DesignSystemTab';

const updateProjectSettings = vi.fn(async () => ({ success: true }));

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { design: { ...designMock }, updateProjectSettings, openExternal: vi.fn() };
});

describe('DesignSystemTab', () => {
  it('goes from empty, through a brief and three directions, to the written system', async () => {
    const propose = vi.spyOn(designMock, 'propose');
    (window as unknown as { electronAPI: { design: typeof designMock } }).electronAPI.design = designMock;
    render(<DesignSystemTab projectId="p1" />);

    expect(await screen.findByText('context.design.extractTitle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'context.design.generate' }));
    const propose_ = screen.getByRole('button', { name: /context.design.propose/ });
    expect(propose_).toBeDisabled();
    fireEvent.change(screen.getByLabelText('context.design.brief.product'), { target: { value: 'An app for AI teams' } });
    fireEvent.click(propose_);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'context.design.useDirection' })).toHaveLength(3));
    expect(propose).toHaveBeenCalledWith('p1', expect.objectContaining({ product: 'An app for AI teams' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'context.design.useDirection' })[1]);

    // The written system shows its tokens and the QA mode
    expect((await screen.findAllByText('#E8EAE3')).length).toBeGreaterThan(0);
    expect(screen.getByRole('radio', { name: /context.design.qaModes.block/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /context.design.qaModes.warn/ }));
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledWith('p1', { designQaMode: 'warn' }));
  }, 15_000);

  it('asks before replacing an existing design system', async () => {
    await designMock.extract('p1'); // the mock now holds a system
    const extract = vi.spyOn(designMock, 'extract');
    extract.mockClear();
    (window as unknown as { electronAPI: { design: typeof designMock } }).electronAPI.design = designMock;
    render(<DesignSystemTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /context.design.extractAgain/ }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('context.design.replaceApp');
    expect(extract).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'buttons.cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /context.design.extractAgain/ }));
    fireEvent.click(screen.getByRole('button', { name: 'context.design.replace' }));
    await waitFor(() => expect(extract).toHaveBeenCalledWith('p1'));
  });
});
