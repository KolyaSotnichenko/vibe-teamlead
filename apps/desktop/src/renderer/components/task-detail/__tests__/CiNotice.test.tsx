/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../../../../shared/types';
import type { DeployTarget } from "../../../../shared/types/deploy";

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key),
    i18n: { language: 'en' },
  }),
}));

import { resetPreviewSubscription } from '../useCiState';
import { CiNotice } from '../CiNotice';

const task = { id: 't1', projectId: 'p1' } as unknown as Task;
const setup = (data: unknown, onGoToDeploy: ReturnType<typeof vi.fn> | null = vi.fn()) => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    deploy: { previewState: vi.fn(async () => data), onPreviewUpdate: vi.fn(() => () => undefined) },
  };
  render(<CiNotice task={task} onGoToDeploy={(onGoToDeploy as ((t: DeployTarget) => void) | null) ?? undefined} />);
  return { onGoToDeploy };
};
afterEach(() => {
  cleanup();
  resetPreviewSubscription();
});

describe('CiNotice', () => {
  it('says CI status appears once CI is set up, and goes to the environment tab', async () => {
    const { onGoToDeploy } = setup({ state: 'not-set-up' });
    expect(await screen.findByText('taskCi.notSetUp')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'taskCi.setUp' }));
    expect(onGoToDeploy).toHaveBeenCalledWith({ tab: 'environment' });
  });

  it('says CI status needs a private repository', async () => {
    setup({ state: 'unavailable', reason: 'public-repo' });
    expect(await screen.findByText('taskCi.publicRepo')).toBeInTheDocument();
  });

  it.each([{ state: 'unavailable', reason: 'push-off' }, { state: 'not-pushed' }, { state: 'waiting' }, { state: 'passed' }])('says nothing for %o', async (data) => {
    setup(data);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('gives the reason the last push failed', async () => {
    setup({ state: 'not-pushed', pushError: 'permissions' });
    expect(await screen.findByText(/taskCi\.pushFailed/)).toBeInTheDocument();
    expect(screen.getByText(/taskCi\.pushError\.permissions/)).toBeInTheDocument();
  });

  it('says CI is running, without a button', async () => {
    setup({ state: 'running' });
    expect(await screen.findByText('taskCi.runningTitle')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a failed CI goes to that run and job on Deploy', async () => {
    const { onGoToDeploy } = setup({ state: 'failed', runId: 5, jobId: 9 });
    expect(await screen.findByText('taskCi.failedTitle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'taskCi.openRun' }));
    expect(onGoToDeploy).toHaveBeenCalledWith({ tab: 'runs', runId: 5, jobId: 9 });
  });

  it('a failed CI without a handler dispatches open-deploy', async () => {
    const heard = vi.fn();
    window.addEventListener('open-deploy', heard);
    setup({ state: 'failed', runId: 5 }, null);
    fireEvent.click(await screen.findByRole('button', { name: 'taskCi.openRun' }));
    window.removeEventListener('open-deploy', heard);
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'runs', runId: 5 });
  });
});
