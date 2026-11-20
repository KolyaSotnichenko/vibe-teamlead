/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${key}:${o.count}` : key) }),
}));

import { useAgentQuestionsStore } from '../../../stores/agent-questions-store';
import { useProjectStore } from '../../../stores/project-store';
import { useQueuePauseStore } from '../../../stores/queue-pause-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { useTaskStore } from '../../../stores/task-store';
import { StatusBar } from '../StatusBar';

const readinessState = vi.fn();
const scanReadiness = vi.fn();
let readinessListener: ((u: { projectId: string; state: unknown }) => void) | undefined;

const project = (deploy?: unknown) => ({ id: 'p1', name: 'P', path: '/p', settings: { deploy } });
const ciSetUp = { enabled: true, repo: { owner: 'o', repo: 'r', createdByApp: false } };
const withRun = (conclusion: string) => ({ success: true, data: { scanning: false, tasks: {}, result: { workflow: { lastMainRun: { conclusion, runId: 1 } } } } });

function setup(opts: { project?: unknown; tasks?: Array<{ status: string }> } = {}) {
  useProjectStore.setState({
    projects: opts.project ? [opts.project as never] : [],
    selectedProjectId: opts.project ? 'p1' : null,
  });
  useTaskStore.setState({ tasks: (opts.tasks ?? []).map((t, i) => ({ id: `t${i}`, projectId: 'p1', subtasks: [], ...t })) as never });
  const onViewChange = vi.fn();
  const onSettingsClick = vi.fn();
  render(<StatusBar activeView="kanban" onViewChange={onViewChange} onSettingsClick={onSettingsClick} />);
  return { onViewChange, onSettingsClick };
}

beforeEach(() => {
  readinessState.mockReset().mockResolvedValue({ success: true, data: { scanning: false, tasks: {} } });
  scanReadiness.mockReset();
  readinessListener = undefined;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    deploy: {
      readinessState,
      scanReadiness,
      onReadinessUpdate: (cb: typeof readinessListener) => {
        readinessListener = cb;
        return () => undefined;
      },
    },
  };
  useQueuePauseStore.setState({ paused: false });
  useAgentQuestionsStore.setState({ pending: [], openQuestionId: null });
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, sidebarCollapsed: false } }));
});
afterEach(cleanup);

describe('StatusBar — live state (left)', () => {
  it('is empty with no project open, and Documentation still works', () => {
    const { onViewChange } = setup();
    expect(screen.queryByText(/statusBar\.running/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /items\.context/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /items\.docs/ }));
    expect(onViewChange).toHaveBeenCalledWith('docs');
  });

  it('shows running, queued and ready-for-review tasks of the project and opens the board', () => {
    const { onViewChange } = setup({
      project: project(),
      tasks: [{ status: 'in_progress' }, { status: 'ai_review' }, { status: 'queue' }, { status: 'done' }, { status: 'human_review' }, { status: 'human_review' }],
    });
    expect(screen.getByText('statusBar.running:2')).toBeInTheDocument();
    expect(screen.getByText('statusBar.review:2')).toBeInTheDocument();
    fireEvent.click(screen.getByText('statusBar.queued:1'));
    expect(onViewChange).toHaveBeenCalledWith('kanban');
  });

  it('says when the queue is paused', () => {
    useQueuePauseStore.setState({ paused: true });
    setup({ project: project() });
    expect(screen.getByText('statusBar.paused')).toBeInTheDocument();
  });

  it('leaves a waiting question to the open sidebar, which shows it in words', () => {
    useAgentQuestionsStore.setState({ pending: [{ questionId: 'q1', projectId: 'p1' } as never], openQuestionId: null });
    setup({ project: project() });
    expect(screen.queryByText(/statusBar\.waiting/)).not.toBeInTheDocument();
  });

  it('with the sidebar collapsed, marks a waiting question as needing the user and opens it on click', () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, sidebarCollapsed: true } }));
    useAgentQuestionsStore.setState({ pending: [{ questionId: 'q1', projectId: 'p1' } as never], openQuestionId: null });
    setup({ project: project() });
    const button = screen.getByText('statusBar.waiting:1').closest('button') as HTMLElement;
    expect(button).toHaveAttribute('data-alert', 'true');
    fireEvent.click(button);
    expect(useAgentQuestionsStore.getState().openQuestionId).toBe('q1');
  });

  it('shows the last CI run on main without starting a scan, and opens CI readiness', async () => {
    readinessState.mockResolvedValue(withRun('failure'));
    const opened = vi.fn();
    window.addEventListener('open-deploy', opened);
    setup({ project: project(ciSetUp) });
    const button = (await screen.findByText('statusBar.ci.failing')).closest('button') as HTMLElement;
    expect(button).toHaveAttribute('data-alert', 'true');
    fireEvent.click(button);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'readiness' });
    expect(scanReadiness).not.toHaveBeenCalled();
    window.removeEventListener('open-deploy', opened);
  });

  it('follows readiness updates', async () => {
    readinessState.mockResolvedValue(withRun('failure'));
    setup({ project: project(ciSetUp) });
    await screen.findByText('statusBar.ci.failing');
    act(() => readinessListener?.({ projectId: 'p1', state: withRun('success').data }));
    expect(screen.getByText('statusBar.ci.passing')).toBeInTheDocument();
  });

  it('shows no CI item when CI is not set up, and does not ask main', () => {
    setup({ project: project() });
    expect(screen.queryByText(/statusBar\.ci/)).not.toBeInTheDocument();
    expect(readinessState).not.toHaveBeenCalled();
  });
});

describe('StatusBar — Knowledge (right)', () => {
  it('has Context, Changelog, MCP Overview and Documentation with their shortcuts', () => {
    const { onViewChange } = setup({ project: project() });
    const expected: Array<[string, string, string]> = [
      ['items.context', 'C', 'context'],
      ['items.changelog', 'L', 'changelog'],
      ['items.agentTools', 'M', 'agent-tools'],
      ['items.docs', 'H', 'docs'],
    ];
    for (const [label, key, view] of expected) {
      const button = screen.getByRole('button', { name: new RegExp(label) });
      expect(button).toHaveAttribute('aria-keyshortcuts', key);
      fireEvent.click(button);
      expect(onViewChange).toHaveBeenLastCalledWith(view);
    }
  });

  it('marks the active page', () => {
    useProjectStore.setState({ projects: [project() as never], selectedProjectId: 'p1' });
    render(<StatusBar activeView="changelog" onViewChange={vi.fn()} onSettingsClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /items\.changelog/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /items\.context/ })).not.toHaveAttribute('aria-current');
  });

  it('opens Settings', () => {
    const { onSettingsClick } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'tooltips.settings' }));
    expect(onSettingsClick).toHaveBeenCalled();
  });
});
