/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../../../../../shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const persistTaskStatus = vi.fn(async () => true);
const startTaskOrQueue = vi.fn();
vi.mock('../../../../stores/task-store', () => ({
  persistTaskStatus: (...a: unknown[]) => persistTaskStatus(...(a as [])),
  startTaskOrQueue: (...a: unknown[]) => startTaskOrQueue(...(a as [])),
}));

import { NoWorkspaceMessage } from '../WorkspaceMessages';

afterEach(cleanup);

describe('NoWorkspaceMessage for an architecture-only task', () => {
  it('says the architecture is ready (no code, nothing to merge) and closes the task as done', async () => {
    const task = { id: 't1', status: 'human_review', reviewReason: 'architecture_ready' } as unknown as Task;
    render(<NoWorkspaceMessage task={task} />);
    expect(screen.getByText('taskReview:workspace.architectureReadyTitle')).toBeInTheDocument();
    expect(screen.getByText('taskReview:workspace.architectureReadyBody')).toBeInTheDocument();
    expect(screen.queryByText('taskReview:workspace.noWorkspaceTitle')).not.toBeInTheDocument();
    expect(screen.queryByText('taskReview:workspace.proceedToCoding')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('taskReview:merge.actions.markAsDone'));
    await waitFor(() => expect(persistTaskStatus).toHaveBeenCalledWith('t1', 'done'));
    expect(startTaskOrQueue).not.toHaveBeenCalled();
  });
});
