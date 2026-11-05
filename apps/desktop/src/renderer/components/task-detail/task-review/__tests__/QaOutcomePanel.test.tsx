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

function setup(outcome: QaOutcomeInfo | undefined, allowedPatterns?: Array<{ pattern: string; message: string }>) {
  const save = vi.fn(async () => ({ success: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getTaskWorkspace: vi.fn(async () => ({ success: true, data: { qaOutcome: outcome } })),
    design: { get: vi.fn(async () => ({ success: true, data: { tokens: { colors: [], fonts: [], radius: [0], shadows: false, allowedPatterns } } })), save },
  };
  render(<QaOutcomePanel task={task} />);
  return { save };
}

afterEach(cleanup);

describe('QaOutcomePanel', () => {
  it('says so when QA could not be started', async () => {
    setup({ approved: false, reason: 'max_iterations', iterations: 1, reviewerApproved: false, at: '', blocking: [] });
    submitReview.mockResolvedValueOnce(false);
    await screen.findByText(/qaOutcome.reason.max_iterations/);
    fireEvent.click(screen.getByRole('button', { name: 'qaOutcome.rerun' }));
    await waitFor(() => expect(submitReview).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toHaveTextContent('qaOutcome.startFailed');
  });

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

  it('does not offer Allow again for a finding the tokens already allow', async () => {
    setup(
      {
        approved: false, reason: 'recurring_issues', iterations: 1, reviewerApproved: false, checksRepeat: true, at: '',
        blocking: [
          { source: 'design', title: 'Gradients are not part of the design system', location: 'a.css:1', match: 'repeating-linear-gradient(' },
          { source: 'design', title: 'No shadows', location: 'b.css:2', match: 'box-shadow: 0 1px' },
        ],
      },
      [{ pattern: 'repeating-linear-gradient\\(', message: 'allowed' }],
    );
    expect(await screen.findByText('qaOutcome.allowed')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: /qaOutcome.allow / });
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('box-shadow');
  });

  it('never runs a regular expression from the tokens to decide what is allowed', async () => {
    setup(
      {
        approved: false, reason: 'recurring_issues', iterations: 1, reviewerApproved: false, at: '',
        blocking: [{ source: 'design', title: 'No gradients', location: 'a.css:1', match: 'linear-gradient(' }],
      },
      [{ pattern: '.*', message: 'matches anything' }],
    );
    expect(await screen.findByRole('button', { name: /qaOutcome.allow / })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('qaOutcome.allowed')).not.toBeInTheDocument();
  });

  it('says when a check keeps repeating itself', async () => {
    setup({
      approved: false, reason: 'recurring_issues', iterations: 1, reviewerApproved: false, checksRepeat: true, at: 'now',
      blocking: [{ source: 'design', title: 'No gradients', location: 'a.css:1', match: 'linear-gradient(' }],
    });
    expect(await screen.findByText('qaOutcome.reason.checksRepeat')).toBeInTheDocument();
  });

  it('names the project files the reviewer changed, even when QA approved', async () => {
    setup({ approved: true, iterations: 1, reviewerApproved: true, at: '', blocking: [], reviewerChangedFiles: ['src/app.ts', 'src/fix.ts'] });
    expect(await screen.findByText('qaOutcome.reviewerChanged {"count":2,"files":"src/app.ts, src/fix.ts"}')).toBeInTheDocument();
    expect(screen.queryByText('qaOutcome.title')).not.toBeInTheDocument();
  });

  it('names a commit the reviewer made, by short hashes', async () => {
    setup({ approved: true, iterations: 1, reviewerApproved: true, at: '', blocking: [], reviewerCommitted: { from: 'abc1234567890', to: 'def5678901234' } });
    expect(await screen.findByText('qaOutcome.reviewerCommitted {"from":"abc1234","to":"def5678"}')).toBeInTheDocument();
  });

  it('says when it could not check what the reviewer changed', async () => {
    setup({ approved: true, iterations: 1, reviewerApproved: true, at: '', blocking: [], reviewerChangesUnknown: true });
    expect(await screen.findByText('qaOutcome.reviewerChangesUnknown')).toBeInTheDocument();
  });

  it('shows the changed files with the reasons when QA did not approve', async () => {
    setup({ approved: false, reason: 'max_iterations', iterations: 2, reviewerApproved: false, at: '', blocking: [], reviewerChangedFiles: ['src/app.ts'] });
    expect(await screen.findByText(/qaOutcome.reason.max_iterations/)).toBeInTheDocument();
    expect(screen.getByText('qaOutcome.reviewerChanged {"count":1,"files":"src/app.ts"}')).toBeInTheDocument();
  });

  it('explains a run from before the outcome was recorded', async () => {
    setup(undefined);
    expect(await screen.findByText('qaOutcome.unrecorded')).toBeInTheDocument();
  });

  it('escapes regex characters for an exact match', () => {
    expect(exactPattern('rounded-[12px] (x)')).toBe('rounded-\\[12px\\] \\(x\\)');
  });
});
