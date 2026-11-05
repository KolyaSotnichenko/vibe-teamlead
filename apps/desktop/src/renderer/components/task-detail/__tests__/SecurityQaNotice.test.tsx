/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { SecurityQaNotice } from '../SecurityQaNotice';

const task = (over: Partial<Task> = {}) => ({ id: 't1', projectId: 'p1', status: 'human_review', reviewReason: 'completed', subtasks: [], ...over }) as unknown as Task;

function setup(data: unknown, props = task()) {
  const getTaskSecurityQaError = vi.fn(async () => ({ success: true, data }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { getTaskSecurityQaError };
  return { getTaskSecurityQaError, ...render(<SecurityQaNotice task={props} />) };
}

afterEach(cleanup);

describe('SecurityQaNotice', () => {
  it('says the pentest did not finish, and why', async () => {
    setup({ reason: 'Strix exited with code 1' });
    expect(await screen.findByText('securityQa.title')).toBeInTheDocument();
    expect(screen.getByText('securityQa.body')).toBeInTheDocument();
    expect(screen.getByText('Strix exited with code 1')).toBeInTheDocument();
  });

  it('still warns when the scan gave no reason', async () => {
    setup({});
    expect(await screen.findByText('securityQa.title')).toBeInTheDocument();
  });

  it('shows nothing without an error', async () => {
    const { container, getTaskSecurityQaError } = setup(null);
    await waitFor(() => expect(getTaskSecurityQaError).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('does not ask before the task reaches review', async () => {
    const { container, getTaskSecurityQaError } = setup({ reason: 'old' }, task({ status: 'in_progress' }));
    expect(getTaskSecurityQaError).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});
