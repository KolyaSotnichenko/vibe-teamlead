/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Task } from '../../../../shared/types';

import { useVerification, verificationChanged } from '../useVerification';

const task = { id: 't1', projectId: 'p1', status: 'human_review' } as unknown as Task;

function Status() {
  const summary = useVerification(task);
  return <p>{summary?.status ?? 'none'}</p>;
}

afterEach(cleanup);

describe('useVerification', () => {
  it('reads the summary again when the checks of that task were run again elsewhere, as the card must', async () => {
    const getTaskVerification = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { status: 'not_verified', checks: [] } })
      .mockResolvedValue({ success: true, data: { status: 'passed', checks: [] } });
    (window as unknown as { electronAPI: unknown }).electronAPI = { getTaskVerification };
    render(<Status />);
    expect(await screen.findByText('not_verified')).toBeInTheDocument();
    act(() => verificationChanged('another-task'));
    expect(getTaskVerification).toHaveBeenCalledTimes(1);
    act(() => verificationChanged('t1'));
    expect(await screen.findByText('passed')).toBeInTheDocument();
  });
});
