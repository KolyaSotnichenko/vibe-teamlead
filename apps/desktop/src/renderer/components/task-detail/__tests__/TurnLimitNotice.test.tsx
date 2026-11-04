/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key) }),
}));

import { TurnLimitNotice } from '../TurnLimitNotice';

const task = { id: 't1', projectId: 'p1', status: 'in_progress', subtasks: [] } as unknown as Task;

function setup(turnLimits: unknown) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getTaskWorkspace: vi.fn(async () => ({ success: true, data: { turnLimits } })),
  };
  return render(<TurnLimitNotice task={task} />);
}

afterEach(cleanup);

describe('TurnLimitNotice', () => {
  it('shows nothing when no session reached its limit', async () => {
    const { container } = setup(undefined);
    await waitFor(() => expect(window.electronAPI.getTaskWorkspace).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('names the agent, the subtask, the limit and how many times', async () => {
    setup([{ agentType: 'coder', subtaskId: 's1', limit: 200, count: 2 }, { agentType: 'qa_reviewer', limit: 200, count: 1 }]);
    expect(await screen.findByText('turnLimit.title')).toBeInTheDocument();
    expect(screen.getByText(/coder · s1 · .*×2/)).toBeInTheDocument();
    const reviewer = screen.getByText(/qa_reviewer/);
    expect(reviewer.textContent).not.toContain('×');
  });
});
