/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { Subtask, Task, TaskWorkspace } from '../../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en' },
  }),
}));

import { getTaskStage } from '../../../board/task-stage';
import { pickSubtasks } from '../OverviewSubtasks';
import { stageOfAgent } from '../PendingQuestion';
import { PipelineStrip } from '../PipelineStrip';
import { summarizeSecurity } from '../WorkspaceChecks';

const base: Task = {
  id: 't',
  specId: '001',
  projectId: 'p',
  title: 'T',
  description: '',
  status: 'in_progress',
  subtasks: [],
  logs: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('PipelineStrip', () => {
  it('marks the current stage and opens the section a stage writes', () => {
    const onOpen = vi.fn();
    const info = getTaskStage({ ...base, executionProgress: { phase: 'coding', phaseProgress: 0, overallProgress: 0 } });
    render(<PipelineStrip info={info} onOpen={onOpen} />);
    const current = screen.getAllByRole('listitem').find((li) => li.getAttribute('aria-current') === 'step');
    expect(current).toHaveTextContent('board.stages.coder');
    fireEvent.click(screen.getByRole('button', { name: /board\.stages\.architect/ }));
    expect(onOpen).toHaveBeenCalledWith('architecture');
    fireEvent.click(screen.getByRole('button', { name: /board\.stages\.coder/ }));
    expect(onOpen).toHaveBeenCalledWith('subtasks');
  });

  it('says when the agent at the current stage waits for the user', () => {
    const info = getTaskStage({ ...base, executionProgress: { phase: 'planning', phaseProgress: 0, overallProgress: 0, message: 'Spec creation: x (1/3)' } });
    render(<PipelineStrip info={info} waitingStage="spec" onOpen={vi.fn()} />);
    expect(screen.getByText('agentQuestions.waiting')).toBeInTheDocument();
  });
});

describe('overview helpers', () => {
  it('maps the asking agent to its stage', () => {
    expect(stageOfAgent('spec_gatherer')).toBe('spec');
    expect(stageOfAgent('architect')).toBe('architect');
    expect(stageOfAgent('qa_fixer')).toBe('qa');
    expect(stageOfAgent('mystery')).toBeNull();
  });

  it('lists in-progress and failed subtasks first', () => {
    const s = (id: string, status: Subtask['status']): Subtask => ({ id, title: id, description: '', status, files: [] });
    const picked = pickSubtasks([s('a', 'completed'), s('b', 'pending'), s('c', 'in_progress'), s('d', 'failed')], 3);
    expect(picked.map((x) => x.id)).toEqual(['c', 'd', 'a']);
  });

  it('counts blocking security findings from gates and Strix', () => {
    const ws = {
      security: {
        gates: { ran: ['gitleaks'], skipped: [], findings: [{ source: 'gitleaks', title: 'key', blocking: true }] },
        pentest: {
          status: 'findings',
          findings: [
            { source: 'strix', title: 'xss', blocking: true },
            { source: 'strix', title: 'info', blocking: false },
          ],
        },
      },
    } as unknown as TaskWorkspace;
    expect(summarizeSecurity(ws)).toEqual({ blocking: 2, ran: true, pentest: 'findings' });
    expect(summarizeSecurity({ security: {} } as TaskWorkspace)).toBeNull();
  });
});
