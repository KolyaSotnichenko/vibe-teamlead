/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, params?: { ports?: string }) => (params?.ports ? `${key}:${params.ports}` : key) }) }));

import { STARTS_CHECK_COMMAND } from '../../../../shared/utils/verification-summary';
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

  it('says why the start could not be judged, naming the services, not that it could not be tried', async () => {
    setup({ status: 'not_verified', checks: [{ command: STARTS_CHECK_COMMAND, outcome: 'unavailable', why: { reason: 'missing', names: ['api', 'worker'] } }] });
    expect(await screen.findByText('verification.startsWhy.missing')).toBeInTheDocument();
    expect(screen.queryByText('verification.outcome.notTried')).not.toBeInTheDocument();
  });

  it('says a port is in use without a number when a report kept before had none', async () => {
    setup({ status: 'not_verified', checks: [{ command: STARTS_CHECK_COMMAND, outcome: 'unavailable', why: { reason: 'port' } }] });
    expect(await screen.findByText('verification.startsWhy.portUnnamed')).toBeInTheDocument();
  });

  it('names the port that is in use, with or without a service', async () => {
    setup({ status: 'not_verified', checks: [{ command: STARTS_CHECK_COMMAND, outcome: 'unavailable', why: { reason: 'port', ports: [10000] } }] });
    expect(await screen.findByText('verification.startsWhy.port:10000')).toBeInTheDocument();
  });

  it('runs the checks again when they could not say everything, and shows what they find', async () => {
    const { getTaskVerification } = setup({ status: 'not_verified', checks: [{ command: STARTS_CHECK_COMMAND, outcome: 'unavailable', why: { reason: 'port', ports: [10000] } }] });
    const verifyTaskAgain = vi.fn(async () => ({ success: true, data: { status: 'passed', checks: [{ command: STARTS_CHECK_COMMAND, outcome: 'passed' }] } }));
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = { getTaskVerification, verifyTaskAgain };
    fireEvent.click(await screen.findByRole('button', { name: 'verification.again' }));
    expect(verifyTaskAgain).toHaveBeenCalledWith('t1', 'p1');
    expect(await screen.findByText('verification.passedTitle')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'verification.again' })).not.toBeInTheDocument();
  });

  it('shows what the checks run again found broken, since no other panel says it then, and why a run could not start', async () => {
    const { getTaskVerification } = setup({ status: 'not_verified', checks: [] });
    const verifyTaskAgain = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'The checks are already running for this task.' })
      .mockResolvedValueOnce({ success: true, data: { status: 'regression', checks: [{ command: 'pnpm run test', outcome: 'failed', onBase: 'passed' }] } });
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = { getTaskVerification, verifyTaskAgain };
    fireEvent.click(await screen.findByRole('button', { name: 'verification.again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The checks are already running for this task.');
    fireEvent.click(screen.getByRole('button', { name: 'verification.again' }));
    expect(await screen.findByText('verification.regressionTitle')).toBeInTheDocument();
    expect(screen.getByText('verification.outcome.failed')).toBeInTheDocument();
  });

  it('offers no new run when the checks passed', async () => {
    setup({ status: 'passed', checks: [{ command: 'pnpm run test', outcome: 'passed' }] });
    expect(await screen.findByText('verification.passedTitle')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'verification.again' })).not.toBeInTheDocument();
  });

  it('calls the start-up check by what it means, not by a command', async () => {
    setup({ status: 'not_verified', checks: [{ command: 'pnpm run test', outcome: 'passed' }, { command: STARTS_CHECK_COMMAND, outcome: 'failed', onBase: 'failed' }] });
    expect(await screen.findByText('verification.startsCheck')).toBeInTheDocument();
    expect(screen.queryByText(STARTS_CHECK_COMMAND)).not.toBeInTheDocument();
    expect(screen.getByText('pnpm run test')).toBeInTheDocument();
  });

  it("says the start could not be tried here, not that a tool is missing", async () => {
    setup({ status: 'not_verified', checks: [{ command: STARTS_CHECK_COMMAND, outcome: 'unavailable' }] });
    expect(await screen.findByText('verification.outcome.notTried')).toBeInTheDocument();
  });

  it('says when it had nothing to run, so nobody takes silence for a pass', async () => {
    setup({ status: 'not_configured', checks: [] });
    expect(await screen.findByText('verification.notConfiguredTitle')).toBeInTheDocument();
  });

  it("says when the commands came from the task, because main had none yet", async () => {
    setup({ status: 'passed', source: 'task', checks: [{ command: 'pnpm run test', outcome: 'passed' }] });
    expect(await screen.findByText('verification.passedTitle')).toBeInTheDocument();
    expect(screen.getByText('verification.fromTask')).toBeInTheDocument();
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
