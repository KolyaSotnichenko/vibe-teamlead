/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key) }) }));

import { SecurityFollowupNotice } from '../SecurityFollowupNotice';

const task = { id: 't1', projectId: 'p1', status: 'human_review' } as unknown as Task;
const setup = (data: unknown) => {
  const getTaskSecurityFollowup = vi.fn(async () => ({ success: true, data }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { getTaskSecurityFollowup };
  return { getTaskSecurityFollowup, ...render(<SecurityFollowupNotice task={task} />) };
};
afterEach(cleanup);

describe('SecurityFollowupNotice', () => {
  it('says what was found and where it went', async () => {
    setup({ specId: '026-security-fixes-from-015', count: 2 });
    expect(await screen.findByText(/securityFollowup.title/)).toBeInTheDocument();
    expect(screen.getByText(/026-security-fixes-from-015/)).toBeInTheDocument();
  });

  it('shows nothing without one', async () => {
    const { container, getTaskSecurityFollowup } = setup(null);
    await waitFor(() => expect(getTaskSecurityFollowup).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
