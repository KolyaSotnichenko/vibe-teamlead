/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QaOutcomeInfo, Task } from '../../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key) }),
}));
const submitReview = vi.fn(async () => true);
vi.mock('../../../../stores/task-store', () => ({ submitReview: (...a: unknown[]) => submitReview(...(a as [])) }));

import { exactPattern, QaOutcomePanel } from '../QaOutcomePanel';

const task = { id: 't1', projectId: 'p1', title: 'Auth', status: 'human_review', reviewReason: 'errors' } as unknown as Task;

function setup(outcome: QaOutcomeInfo | undefined) {
  const save = vi.fn(async () => ({ success: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getTaskWorkspace: vi.fn(async () => ({ success: true, data: { qaOutcome: outcome } })),
    design: { get: vi.fn(async () => ({ success: true, data: { tokens: { colors: [], fonts: [], radius: [0], shadows: false } } })), save },
  };
  render(<QaOutcomePanel task={task} />);
  return { save };
}

afterEach(cleanup);

describe('QaOutcomePanel', () => {
  it('says the reviewer approved but the design check blocked, and allows the exact finding in the tokens', async () => {
    const { save } = setup({
      approved: false, reason: 'recurring_issues', iterations: 3, reviewerApproved: true, at: '',
      blocking: [{ source: 'design', title: 'Gradients are not part of the design system', location: 'src/Grid.tsx:7', match: 'repeating-linear-gradient(' }],
    });
    expect(await screen.findByText('qaOutcome.reason.checksBlocked')).toBeInTheDocument();
    expect(screen.getByText('src/Grid.tsx:7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /qaOutcome.allow / }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const tokens = (save.mock.calls[0] as unknown as [string, { tokens: { allowedPatterns: Array<{ pattern: string }> } }])[1].tokens;
    expect(tokens.allowedPatterns[0].pattern).toBe('repeating-linear-gradient\\(');
    expect(await screen.findByText('qaOutcome.allowed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'qaOutcome.rerun' }));
    await waitFor(() => expect(submitReview).toHaveBeenCalledWith('t1', false, undefined, undefined, { rerunOnly: true }));
  });

  it('says when a check keeps repeating itself', async () => {
    setup({
      approved: false, reason: 'recurring_issues', iterations: 1, reviewerApproved: false, checksRepeat: true, at: 'now',
      blocking: [{ source: 'design', title: 'No gradients', location: 'a.css:1', match: 'linear-gradient(' }],
    });
    expect(await screen.findByText('qaOutcome.reason.checksRepeat')).toBeInTheDocument();
  });

  it('explains a run from before the outcome was recorded', async () => {
    setup(undefined);
    expect(await screen.findByText('qaOutcome.unrecorded')).toBeInTheDocument();
  });

  it('escapes regex characters for an exact match', () => {
    expect(exactPattern('rounded-[12px] (x)')).toBe('rounded-\\[12px\\] \\(x\\)');
  });
});
