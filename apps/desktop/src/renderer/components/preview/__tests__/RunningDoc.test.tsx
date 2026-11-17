/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
const createTask = vi.fn(async () => ({ id: 't1' }));
vi.mock('../../../stores/task-store', () => ({ createTask: (...a: unknown[]) => createTask(...(a as [])) }));
const openTerminal = vi.fn();
vi.mock('../../../lib/open-terminal', () => ({ openTerminal: (cwd: string) => openTerminal(cwd) }));

import { RunningDoc, useRunningDoc } from '../RunningDoc';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RunningDoc', () => {
  it("shows the project's RUNNING.md and opens a terminal in its folder, typing nothing", () => {
    render(<RunningDoc projectId="p1" doc={{ exists: true, markdown: '## Start\n\n`npm run dev`', truncated: false, dir: '/projects/planner' }} />);
    expect(screen.getByRole('heading', { name: 'Start' })).toBeInTheDocument();
    expect(screen.getByText('npm run dev')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'preview.running.openTerminal' }));
    expect(openTerminal).toHaveBeenCalledWith('/projects/planner');
    expect(screen.queryByText('preview.running.truncated')).not.toBeInTheDocument();
  });

  it('says when the file was cut', () => {
    render(<RunningDoc projectId="p1" doc={{ exists: true, markdown: 'x', truncated: true, dir: '/p' }} />);
    expect(screen.getByText('preview.running.truncated')).toBeInTheDocument();
  });

  it('without RUNNING.md, offers the task that writes it instead of a terminal', async () => {
    render(<RunningDoc projectId="p1" doc={{ exists: false, dir: '/p' }} />);
    expect(screen.queryByRole('button', { name: 'preview.running.openTerminal' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'preview.running.createTask' }));
    await waitFor(() => expect(screen.getByText('preview.running.taskCreated')).toBeInTheDocument());
    expect(createTask).toHaveBeenCalledWith('p1', expect.stringContaining('RUNNING.md'), expect.stringContaining('## Acceptance criteria'));
  });

  it('shows nothing until it knows', () => {
    const { container } = render(<RunningDoc projectId="p1" doc={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useRunningDoc', () => {
  it("reads the project's, or the task's, RUNNING.md and reads it again when asked", async () => {
    const runningDoc = vi.fn(async () => ({ success: true, data: { exists: false, dir: '/p' } }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { preview: { runningDoc } };
    const { result, rerender } = renderHook(({ again }) => useRunningDoc('p1', 't1', again), { initialProps: { again: 'a' } });
    await waitFor(() => expect(result.current).toEqual({ exists: false, dir: '/p' }));
    expect(runningDoc).toHaveBeenCalledWith('p1', 't1');
    rerender({ again: 'b' });
    await waitFor(() => expect(runningDoc).toHaveBeenCalledTimes(2));
  });
});
