/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../../stores/project-store', () => ({ loadProjects: vi.fn(async () => {}) }));

import type { DesignSystemInfo } from '../../../../shared/types';
import { designMock } from '../../../lib/mocks/design-mock';
import { DesignSystemTab } from '../DesignSystemTab';

const updateProjectSettings = vi.fn(async () => ({ success: true }));
const empty: DesignSystemInfo = { exists: false, source: 'none', qaMode: 'off', storybook: { detected: false, enabled: false } };

function mount(design: Partial<typeof designMock> = {}) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { design: { ...designMock, ...design }, updateProjectSettings, openExternal: vi.fn() };
  render(<DesignSystemTab projectId="p1" />);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('DesignSystemTab', () => {
  it('opens on Setup with the two paths when there is no system; the view says to set one up', async () => {
    mount({ get: async () => ({ success: true, data: empty }) });
    expect(await screen.findByRole('tab', { name: 'context.design.tabs.setup' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /context.design.start.keepTitle/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /context.design.start.newTitle/ })).toBeInTheDocument();
    // References belong to a path: none until one is picked
    expect(screen.queryByRole('region', { name: 'context.design.refs.title' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'context.design.tabs.view' }));
    expect(screen.getByText('context.design.view.emptyTitle')).toBeInTheDocument();
  });

  it('path A: brand rules are added as "As is", then extract, then the system is shown', async () => {
    const extract = vi.fn(designMock.extract);
    const addReferenceUrls = vi.fn(designMock.addReferenceUrls);
    mount({ get: async () => ({ success: true, data: empty }), extract, addReferenceUrls });
    fireEvent.click(await screen.findByRole('button', { name: /context.design.start.keepTitle/ }));
    const panel = screen.getByRole('list', { name: 'context.design.start.keepTitle' });
    fireEvent.change(within(panel).getByLabelText('context.design.refs.sites'), { target: { value: 'brand.example.com' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'context.design.refs.addSites' }));
    await waitFor(() => expect(addReferenceUrls).toHaveBeenCalledWith('p1', ['brand.example.com'], 'as-is'));
    fireEvent.click(within(panel).getByRole('button', { name: /context.design.start.extract/ }));
    await waitFor(() => expect(extract).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'context.design.tabs.view' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getAllByText('#E8EAE3').length).toBeGreaterThan(0);
  });

  it('path B: references, then a brief and three directions, then the written system', async () => {
    const propose = vi.fn(designMock.propose);
    mount({ get: async () => ({ success: true, data: empty }), propose });
    fireEvent.click(await screen.findByRole('button', { name: /context.design.start.newTitle/ }));
    const panel = screen.getByRole('list', { name: 'context.design.start.newTitle' });
    expect(within(panel).getByText('context.design.setup.new.refsTitle')).toBeInTheDocument();
    const go = within(panel).getByRole('button', { name: /context.design.propose/ });
    expect(go).toBeDisabled();
    fireEvent.change(within(panel).getByLabelText('context.design.brief.product'), { target: { value: 'An app for AI teams' } });
    fireEvent.click(go);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'context.design.useDirection' })).toHaveLength(3));
    expect(propose).toHaveBeenCalledWith('p1', expect.objectContaining({ product: 'An app for AI teams' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'context.design.useDirection' })[1]);
    expect((await screen.findAllByText('#E8EAE3')).length).toBeGreaterThan(0);
  }, 15_000);

  it('opens on Overview when the system is up to date, with how far the code is from it; Setup holds QA and Storybook', async () => {
    const info = (await designMock.extract('p1')).data!;
    mount({ get: async () => ({ success: true, data: { ...info, meta: { writtenAt: '2999-01-01T00:00:00Z', how: 'extract', referenceIds: [] } } }) });
    expect(await screen.findByRole('tab', { name: 'context.design.tabs.view' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByText('#E8EAE3').length).toBeGreaterThan(0);
    expect(screen.getByText('context.design.apply.title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'context.design.tabs.setup' }));
    expect(screen.getByText('context.design.setup.current')).toBeInTheDocument();
    expect(screen.queryByText('context.design.apply.title')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /context.design.qaModes.warn/ }));
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledWith('p1', { designQaMode: 'warn' }));
  });

  it('asks before extracting over an existing system', async () => {
    const info = (await designMock.extract('p1')).data!;
    const extract = vi.fn(designMock.extract);
    mount({ get: async () => ({ success: true, data: info }), extract });
    fireEvent.click(await screen.findByRole('tab', { name: 'context.design.tabs.setup' }));
    fireEvent.click(screen.getByRole('button', { name: /context.design.start.keepTitle/ }));
    fireEvent.click(screen.getByRole('button', { name: /context.design.extractAgain/ }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('context.design.replaceApp');
    expect(extract).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'context.design.replace' }));
    await waitFor(() => expect(extract).toHaveBeenCalledWith('p1'));
  });

  it('opens on Setup with the update banner when references came after the system; its button opens path A', async () => {
    const info = (await designMock.extract('p1')).data!;
    mount({ get: async () => ({ success: true, data: { ...info, meta: { writtenAt: '2020-01-01T00:00:00Z', how: 'extract', referenceIds: [] } } }) });
    const banner = await screen.findByRole('region', { name: /context.design.stale.title/ });
    expect(screen.getByRole('tab', { name: 'context.design.tabs.setup' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(banner).getByRole('button', { name: 'context.design.stale.refresh' }));
    const panel = screen.getByRole('list', { name: 'context.design.start.keepTitle' });
    expect((await within(panel).findAllByText('context.design.refs.fresh')).length).toBeGreaterThan(0);
  });
});
