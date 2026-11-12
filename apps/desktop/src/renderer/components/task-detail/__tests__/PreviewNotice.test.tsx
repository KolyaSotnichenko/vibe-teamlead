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

  it('shows the link and when it was built', async () => {
    const { openExternal } = setup({ state: 'ready', url: 'https://x.vercel.app', builtAt: new Date().toISOString() });
    fireEvent.click(await screen.findByRole('button', { name: 'https://x.vercel.app' }));
    expect(openExternal).toHaveBeenCalledWith('https://x.vercel.app');
    expect(screen.getByText(/taskPreview\.built/)).toBeInTheDocument();
  });

  it('shows nothing while building', async () => {
    setup({ state: 'building' });
    await Promise.resolve();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
