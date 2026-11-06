/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { VerificationNotice } from '../VerificationNotice';

const task = { id: 't1', projectId: 'p1', status: 'human_review' } as unknown as Task;
const setup = (data: unknown, props = task) => {
  const getTaskVerification = vi.fn(async () => ({ success: true, data }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { getTaskVerification };
  return { getTaskVerification, ...render(<VerificationNotice task={props} />) };
};
afterEach(cleanup);

describe('VerificationNotice', () => {
  it('says the checks passed, and which', async () => {
    setup({ status: 'passed', checks: [{ command: 'pnpm run test', outcome: 'passed' }], services: { status: 'started', images: ['postgres:18'] } });
    expect(await screen.findByText('verification.passedTitle')).toBeInTheDocument();
    expect(screen.getByText('pnpm run test')).toBeInTheDocument();
    expect(screen.getByText('verification.temporaryDatabase')).toBeInTheDocument();
  });

  it('says in plain words when Docker is what is missing', async () => {
    setup({ status: 'not_verified', checks: [{ command: 'pnpm run test', outcome: 'failed', onBase: 'failed' }], services: { status: 'unavailable', images: ['postgres:18'] } });
    expect(await screen.findByText('verification.notVerifiedTitle')).toBeInTheDocument();
    expect(screen.getByText('verification.dockerNeeded')).toBeInTheDocument();
    expect(screen.getByText('verification.outcome.sameOnBase')).toBeInTheDocument();
  });

  it('says when it had nothing to run, so nobody takes silence for a pass', async () => {
    setup({ status: 'not_configured', checks: [] });
    expect(await screen.findByText('verification.notConfiguredTitle')).toBeInTheDocument();
  });

  it('says when migrations were left out', async () => {
    setup({ status: 'passed', checks: [], migrationsSkipped: true });
    expect(await screen.findByText('verification.migrationsSkipped')).toBeInTheDocument();
  });

  it('leaves a regression to the panel that lists what to fix', async () => {
    const { container, getTaskVerification } = setup({ status: 'regression', checks: [] });
    await waitFor(() => expect(getTaskVerification).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing before the task reaches review', async () => {
    const { getTaskVerification } = setup({ status: 'passed', checks: [] }, { ...task, status: 'in_progress' } as Task);
    expect(getTaskVerification).not.toHaveBeenCalled();
  });
});
