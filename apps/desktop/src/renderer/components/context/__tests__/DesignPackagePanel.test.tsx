/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Keys come back as text; interpolation values follow the key so the tests can see them
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${Object.values(opts).join(' ')}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../stores/project-store', () => ({ loadProjects: vi.fn(async () => {}), useProjectStore: (select: (s: { projects: unknown[] }) => unknown) => select({ projects: [{ id: 'p1', settings: {} }] }) }));

import type { DesignPackageSummary, DesignSystemInfo } from '../../../../shared/types';
import { designMock } from '../../../lib/mocks/design-mock';
import { DesignPackagePanel } from '../DesignPackagePanel';
import { DesignSystemTab } from '../DesignSystemTab';

const summary: DesignPackageSummary = {
  name: 'MHP Global',
  components: Array.from({ length: 12 }, (_, i) => `Comp${i}`),
  logos: 3,
  fonts: 4,
  colors: { light: 18, dark: 14 },
  hasTokens: true,
  licenceLine: 'The fonts are commercial: use them within the licence.',
  replaces: '.vibe-teamlead/design-system.md',
  skipped: [{ path: 'source/Design.fig', reason: 'type' }],
};

type ProgressEvent = { projectId: string; message: string };
const listeners = new Set<(event: ProgressEvent) => void>();
const progress = (event: ProgressEvent) => act(() => listeners.forEach((cb) => cb(event)));

function api(design: Partial<typeof designMock> = {}) {
  const merged = {
    ...designMock,
    pickPackage: vi.fn(async () => ({ success: true, data: '/tmp/mhp.zip' })),
    inspectPackage: vi.fn(async () => ({ success: true, data: summary })),
    importPackage: vi.fn(designMock.importPackage),
    cancelPackage: vi.fn(async () => ({ success: true })),
    cancel: vi.fn(async () => ({ success: true })),
    onProgress: (cb: (event: ProgressEvent) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    ...design,
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { design: merged, updateProjectSettings: vi.fn(async () => ({ success: true })), openExternal: vi.fn() };
  return merged;
}

async function choose() {
  fireEvent.click(screen.getByRole('button', { name: 'context.design.package.choose' }));
  return screen.findByRole('heading', { name: summary.name });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('DesignPackagePanel', () => {
  it('shows what the package holds after it is inspected', async () => {
    const design = api();
    render(<DesignPackagePanel projectId="p1" onImported={vi.fn()} onError={vi.fn()} />);
    await choose();
    expect(design.inspectPackage).toHaveBeenCalledWith('p1', '/tmp/mhp.zip');
    expect(screen.getByText('context.design.package.components 12')).toBeInTheDocument();
    expect(screen.getByText('context.design.package.logos 3')).toBeInTheDocument();
    expect(screen.getByText('context.design.package.fonts 4')).toBeInTheDocument();
    expect(screen.getByText('context.design.package.colorsLight 18')).toBeInTheDocument();
    expect(screen.getByText('context.design.package.colorsDark 14')).toBeInTheDocument();
    expect(screen.getByText(summary.licenceLine!)).toBeInTheDocument();
    expect(screen.getByText('context.design.package.replaces .vibe-teamlead/design-system.md')).toBeInTheDocument();
    expect(screen.getByText('source/Design.fig')).toBeInTheDocument();
    expect(screen.queryByText('context.design.package.noTokens')).not.toBeInTheDocument();
  });

  it('says the agent will extract tokens when the package has none, and hides the themes without dark colours', async () => {
    api({ inspectPackage: vi.fn(async () => ({ success: true, data: { ...summary, hasTokens: false, colors: { light: 0, dark: 0 }, licenceLine: undefined, replaces: undefined } })) });
    render(<DesignPackagePanel projectId="p1" onImported={vi.fn()} onError={vi.fn()} />);
    await choose();
    expect(screen.getByText('context.design.package.noTokens')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText(/context.design.package.replaces/)).not.toBeInTheDocument();
  });

  it('themes default to light only; Import sends the chosen themes and hands the system back', async () => {
    const design = api();
    const onImported = vi.fn();
    render(<DesignPackagePanel projectId="p1" onImported={onImported} onError={vi.fn()} />);
    await choose();
    expect(screen.getByRole('radio', { name: /context.design.package.themes.light$/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /context.design.package.themes.lightDark$/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'context.design.package.import' }));
    await waitFor(() => expect(design.importPackage).toHaveBeenCalledWith('p1', { themes: 'light' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(onImported.mock.calls[0][0].package.themes).toBe('light');
  });

  it('Import with both themes chosen sends light-dark', async () => {
    const design = api();
    render(<DesignPackagePanel projectId="p1" onImported={vi.fn()} onError={vi.fn()} />);
    await choose();
    fireEvent.click(screen.getByRole('radio', { name: /context.design.package.themes.lightDark$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'context.design.package.import' }));
    await waitFor(() => expect(design.importPackage).toHaveBeenCalledWith('p1', { themes: 'light-dark' }));
  });

  it('shows progress lines while importing', async () => {
    let finish: (v: { success: boolean; data?: DesignSystemInfo }) => void = () => {};
    const design = api({ importPackage: vi.fn(() => new Promise<{ success: boolean; data?: DesignSystemInfo }>((r) => (finish = r))) });
    render(<DesignPackagePanel projectId="p1" onImported={vi.fn()} onError={vi.fn()} />);
    await choose();
    fireEvent.click(screen.getByRole('button', { name: 'context.design.package.import' }));
    await waitFor(() => expect(design.importPackage).toHaveBeenCalled());
    progress({ projectId: 'p1', message: 'Reading the package README…' });
    progress({ projectId: 'other', message: 'Not ours' });
    expect(await screen.findByText('Reading the package README…')).toBeInTheDocument();
    expect(screen.queryByText('Not ours')).not.toBeInTheDocument();
    // A failed import puts the summary back, so it can be imported again
    await act(async () => finish({ success: false }));
    expect(await screen.findByRole('heading', { name: summary.name })).toBeInTheDocument();
  });

  it('a package still being read when the panel goes away is dropped', async () => {
    let read: (v: { success: boolean; data?: DesignPackageSummary }) => void = () => {};
    const design = api({ inspectPackage: vi.fn(() => new Promise<{ success: boolean; data?: DesignPackageSummary }>((r) => (read = r))) });
    const { unmount } = render(<DesignPackagePanel projectId="p1" onImported={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'context.design.package.choose' }));
    await waitFor(() => expect(design.inspectPackage).toHaveBeenCalled());
    unmount();
    await act(async () => read({ success: true, data: summary }));
    expect(design.cancelPackage).toHaveBeenCalledWith('p1');
  });

  it('a summary does not follow the panel to another project', async () => {
    const design = api();
    const { rerender } = render(<DesignPackagePanel projectId="p1" onImported={vi.fn()} onError={vi.fn()} />);
    await choose();
    rerender(<DesignPackagePanel projectId="p2" onImported={vi.fn()} onError={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: summary.name })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'context.design.package.choose' })).toBeInTheDocument();
    expect(design.cancelPackage).toHaveBeenCalledWith('p1');
  });

  it('the themes group is named by its heading', async () => {
    api();
    render(<DesignPackagePanel projectId="p1" onImported={vi.fn()} onError={vi.fn()} />);
    await choose();
    const group = screen.getByRole('radiogroup', { name: 'context.design.package.themes.title' });
    expect(group).toHaveAttribute('aria-labelledby');
    expect(group).not.toHaveAttribute('aria-label');
  });

  it('Cancel drops the inspected package and goes back to choosing', async () => {
    const design = api();
    render(<DesignPackagePanel projectId="p1" onImported={vi.fn()} onError={vi.fn()} />);
    await choose();
    fireEvent.click(screen.getByRole('button', { name: 'buttons.cancel' }));
    await waitFor(() => expect(design.cancelPackage).toHaveBeenCalledWith('p1'));
    expect(screen.getByRole('button', { name: 'context.design.package.choose' })).toBeInTheDocument();
    expect(design.importPackage).not.toHaveBeenCalled();
  });

  it('nothing happens when the dialog is closed; an inspect error is reported', async () => {
    const onError = vi.fn();
    const design = api({ pickPackage: vi.fn(async () => ({ success: true, data: null })) });
    render(<DesignPackagePanel projectId="p1" onImported={vi.fn()} onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: 'context.design.package.choose' }));
    await waitFor(() => expect(design.pickPackage).toHaveBeenCalled());
    expect(design.inspectPackage).not.toHaveBeenCalled();
    cleanup();
    api({ inspectPackage: vi.fn(async () => ({ success: false, error: 'Too many files' })) });
    render(<DesignPackagePanel projectId="p1" onImported={vi.fn()} onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: 'context.design.package.choose' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Too many files'));
    expect(screen.getByRole('button', { name: 'context.design.package.choose' })).toBeInTheDocument();
  });
});

describe('DesignSystemTab with a package', () => {
  const empty: DesignSystemInfo = { exists: false, source: 'none', qaMode: 'off', storybook: { detected: false, enabled: false } };

  it('Setup has a third path that imports a package, then shows Overview', async () => {
    const design = api({ get: async () => ({ success: true, data: empty }) });
    render(<DesignSystemTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /context.design.package.title/ }));
    await choose();
    fireEvent.click(screen.getByRole('button', { name: 'context.design.package.import' }));
    await waitFor(() => expect(design.importPackage).toHaveBeenCalledWith('p1', { themes: 'light' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'context.design.tabs.view' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText(/context.design.status.package MHP Global/)).toBeInTheDocument();
  });

  it('while a package imports, the paths and the parts are locked and the tab shows progress with Cancel', async () => {
    type Result = { success: boolean; data?: DesignSystemInfo; error?: string };
    let finish: (v: Result) => void = () => {};
    const design = api({ get: async () => ({ success: true, data: empty }), importPackage: vi.fn(() => new Promise<Result>((r) => (finish = r))) });
    render(<DesignSystemTab projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /context.design.package.title/ }));
    await choose();
    fireEvent.click(screen.getByRole('button', { name: 'context.design.package.import' }));
    await waitFor(() => expect(design.importPackage).toHaveBeenCalled());
    for (const name of [/context.design.start.keepTitle/, /context.design.start.newTitle/, /context.design.package.title/]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    for (const tab of screen.getAllByRole('tab')) expect(tab).toBeDisabled();
    expect(screen.getByText('context.design.working.package')).toBeInTheDocument();
    progress({ projectId: 'p1', message: 'Writing design-system.md…' });
    expect((await screen.findAllByText('Writing design-system.md…')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'buttons.cancel' }));
    expect(design.cancel).toHaveBeenCalledWith('p1');
    await act(async () => finish({ success: false, error: 'Cancelled' }));
    expect(await screen.findByRole('heading', { name: summary.name })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'context.design.tabs.view' })).not.toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Overview switches the themes of an imported package; an error shows as the tab error', async () => {
    const imported = (await designMock.importPackage('p1', { themes: 'light' })).data!;
    const info = { ...imported, meta: { ...imported.meta!, writtenAt: '2999-01-01T00:00:00Z' } };
    const setThemes = vi.fn(async () => ({ success: false, error: "This package has no token files, so its themes can't be switched" }));
    api({ get: async () => ({ success: true, data: info }), setThemes });
    render(<DesignSystemTab projectId="p1" />);
    const both = await screen.findByRole('radio', { name: /context.design.package.themes.lightDark$/ });
    expect(screen.getByRole('radio', { name: /context.design.package.themes.light$/ })).toBeChecked();
    fireEvent.click(both);
    await waitFor(() => expect(setThemes).toHaveBeenCalledWith('p1', 'light-dark'));
    expect(await screen.findByRole('alert')).toHaveTextContent("can't be switched");
    // Setup marks the package path as current
    fireEvent.click(screen.getByRole('tab', { name: 'context.design.tabs.setup' }));
    expect(screen.getByRole('button', { name: /context.design.package.title/ })).toHaveTextContent('context.design.setup.current');
  });
});
