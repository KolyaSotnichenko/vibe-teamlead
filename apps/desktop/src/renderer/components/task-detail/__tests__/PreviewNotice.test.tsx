/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: 'en' },
  }),
}));

import { resetPreviewSubscription } from '../usePreview';
import { PreviewNotice } from '../PreviewNotice';

const task = { id: 't1', projectId: 'p1' } as unknown as Task;
const setup = (data: unknown, onGoToDeploy = vi.fn()) => {
  const openExternal = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    openExternal,
    deploy: { previewState: vi.fn(async () => data), onPreviewUpdate: vi.fn(() => () => undefined) },
  };
  render(<PreviewNotice task={task} onGoToDeploy={onGoToDeploy} />);
  return { onGoToDeploy, openExternal };
};
afterEach(() => {
  cleanup();
  resetPreviewSubscription();
});

describe('PreviewNotice', () => {
  it('says a link appears after set-up, and goes to the environment tab', async () => {
    const { onGoToDeploy } = setup({ state: 'not-set-up' });
    expect(await screen.findByText('taskPreview.notSetUp')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'taskPreview.setUp' }));
    expect(onGoToDeploy).toHaveBeenCalledWith({ tab: 'environment' });
  });

  it('says previews need a private repository', async () => {
    setup({ state: 'unavailable', reason: 'public-repo' });
    expect(await screen.findByText('taskPreview.publicRepo')).toBeInTheDocument();
  });

  it('says nothing when push is off', async () => {
    setup({ state: 'unavailable', reason: 'push-off' });
    await Promise.resolve();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('gives the reason the last push failed', async () => {
    setup({ state: 'not-pushed', pushError: 'permissions' });
    expect(await screen.findByText(/taskPreview\.pushFailed/)).toBeInTheDocument();
    expect(screen.getByText(/taskPreview\.pushError\.permissions/)).toBeInTheDocument();
  });

  it('built without a preview address: says it is built and opens the Vercel page', async () => {
    const { openExternal } = setup({ state: 'built', logUrl: 'https://vercel.com/acme/app/AbC', builtAt: new Date().toISOString() });
    expect(await screen.findByText('taskPreview.builtTitle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'taskPreview.openInVercel' }));
    expect(openExternal).toHaveBeenCalledWith('https://vercel.com/acme/app/AbC');
  });

  it('shows the link and when it was built', async () => {
    const { openExternal } = setup({ state: 'ready', url: 'https://x.vercel.app', builtAt: new Date().toISOString() });
    fireEvent.click(await screen.findByRole('button', { name: 'https://x.vercel.app' }));
    expect(openExternal).toHaveBeenCalledWith('https://x.vercel.app');
    expect(screen.getByText(/taskPreview\.built/)).toBeInTheDocument();
  });

  it('says the preview is building', async () => {
    setup({ state: 'building' });
    expect(await screen.findByText('taskPreview.building')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('while building, offers the previous link when https', async () => {
    const { openExternal } = setup({ state: 'building', previousUrl: 'https://old.vercel.app' });
    expect(await screen.findByText('taskPreview.building')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'https://old.vercel.app' }));
    expect(openExternal).toHaveBeenCalledWith('https://old.vercel.app');
  });

  it('while building, no link for a previous URL that is not https', async () => {
    setup({ state: 'building', previousUrl: 'http://old.vercel.app' });
    expect(await screen.findByText('taskPreview.building')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a failed preview opens Vercel\'s build log', async () => {
    const { openExternal, onGoToDeploy } = setup({ state: 'failed', logUrl: 'https://vercel.com/log' });
    expect(await screen.findByText('taskPreview.previewFailed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'taskPreview.openLog' }));
    expect(openExternal).toHaveBeenCalledWith('https://vercel.com/log');
    expect(onGoToDeploy).not.toHaveBeenCalled();
  });

  it('a failed preview with a failed run goes to that run on Deploy', async () => {
    const { openExternal, onGoToDeploy } = setup({ state: 'failed', runId: 5, jobId: 9, logUrl: 'https://vercel.com/log' });
    fireEvent.click(await screen.findByRole('button', { name: 'taskPreview.openRun' }));
    expect(onGoToDeploy).toHaveBeenCalledWith({ tab: 'runs', runId: 5, jobId: 9 });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('a failed preview with no run and no log goes to Deploy\'s runs', async () => {
    const { onGoToDeploy } = setup({ state: 'failed' });
    fireEvent.click(await screen.findByRole('button', { name: 'taskPreview.openDeploy' }));
    expect(onGoToDeploy).toHaveBeenCalledWith({ tab: 'runs' });
  });
});
