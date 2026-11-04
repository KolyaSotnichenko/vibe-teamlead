/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { BriefQuestionEvent, BriefAPI, BriefProgressEvent, BriefProposal, BriefTaskDraft } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en' },
  }),
}));

const noop = () => undefined;
const loadTasks = vi.fn(async () => undefined);
vi.mock('../../../stores/task-store', () => ({ loadTasks: (...args: unknown[]) => loadTasks(...(args as [])) }));

import { BriefImportDialog } from '../BriefImportDialog';
import {
  buildCreatePayload,
  computeWaves,
  dependentsOf,
  formatFileSize,
  formatStopwatch,
  groupByEpic,
  isSupportedBriefFile,
  lostDependencies,
} from '../brief-review-model';

function draft(key: string, dependsOn: string[] = [], extra: Partial<BriefTaskDraft> = {}): BriefTaskDraft {
  return {
    key,
    title: `Task ${key}`,
    description: `About ${key}`,
    epic: 'E1',
    acceptanceCriteria: [`Given ${key}, when done, then it works.`],
    dependsOn,
    complexity: 'medium',
    priority: 'medium',
    category: 'feature',
    ...extra,
  };
}

// T1 ← T2 ← T4, T1 ← T3, T5 has no deps
const TASKS = [draft('T1'), draft('T2', ['T1']), draft('T3', ['T1']), draft('T4', ['T2', 'T3']), draft('T5', [], { epic: undefined })];

const proposal: BriefProposal = {
  briefId: 'b-1',
  title: 'Invoicing',
  summary: 'Invoices end to end',
  epics: [{ key: 'E1', title: 'Invoices' }],
  tasks: TASKS,
  assumptions: ['One currency'],
  openQuestions: ['Which email provider?'],
};

describe('brief review model', () => {
  it('reports which included tasks lose a dependency when a task is left out', () => {
    const lost = lostDependencies(TASKS, new Set(['T1']));
    expect(Object.fromEntries(lost)).toEqual({ T2: ['T1'], T3: ['T1'] });
    expect(dependentsOf(TASKS, 'T1', new Set(['T1']))).toEqual(['T2', 'T3']);
    // A left-out task's own dependencies are not "lost"
    expect(lostDependencies(TASKS, new Set(['T1', 'T2'])).has('T2')).toBe(false);
  });

  it('drops dependencies on left-out, unknown and self keys from the payload', () => {
    const tasks = [...TASKS, draft('T6', ['T6', 'T9', 'T5', 'T5'], { title: '  Padded  ', acceptanceCriteria: ['  keep ', '   '] })];
    const payload = buildCreatePayload(tasks, new Set(['T2']));
    expect(payload.map((t) => t.key)).toEqual(['T1', 'T3', 'T4', 'T5', 'T6']);
    expect(payload.find((t) => t.key === 'T4')?.dependsOn).toEqual(['T3']);
    const t6 = payload.find((t) => t.key === 'T6');
    expect(t6?.dependsOn).toEqual(['T5']);
    expect(t6?.title).toBe('Padded');
    expect(t6?.acceptanceCriteria).toEqual(['keep']);
    // Input is not mutated
    expect(tasks[3].dependsOn).toEqual(['T2', 'T3']);
  });

  it('orders tasks into waves, keeping proposal order inside a wave', () => {
    expect(computeWaves(TASKS)).toEqual({ waves: [['T1', 'T5'], ['T2', 'T3'], ['T4']], cyclic: [] });
    // Without T1 (its dependents lose it), T2 and T3 start first
    expect(computeWaves(buildCreatePayload(TASKS, new Set(['T1']))).waves).toEqual([['T2', 'T3', 'T5'], ['T4']]);
  });

  it('reports a dependency cycle instead of looping', () => {
    const result = computeWaves([draft('A', ['B']), draft('B', ['A']), draft('C')]);
    expect(result.waves).toEqual([['C']]);
    expect(result.cyclic).toEqual(['A', 'B']);
  });

  it('groups by epic in proposal order, loose tasks last', () => {
    const groups = groupByEpic(proposal.epics, TASKS);
    expect(groups.map((g) => g.epic?.key ?? null)).toEqual(['E1', null]);
    expect(groups[1].tasks.map((t) => t.key)).toEqual(['T5']);
  });

  it('formats data values', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(18_500)).toBe('18 KB');
    expect(formatFileSize(1_300_000)).toBe('1.2 MB');
    expect(formatStopwatch(75)).toBe('1:15');
    expect(formatStopwatch(3725)).toBe('1:02:05');
    expect(isSupportedBriefFile('Brief.DOCX')).toBe(true);
    expect(isSupportedBriefFile('photo.png')).toBe(false);
  });
});

describe('BriefImportDialog', () => {
  let progress: ((e: BriefProgressEvent) => void) | null;
  let brief: { [K in keyof BriefAPI]: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    progress = null;
    loadTasks.mockClear();
    brief = {
      pickFile: vi.fn(async () => ({ success: true, data: '/tmp/brief.md' })),
      pathForFile: vi.fn((f: File) => `/drop/${f.name}`),
      analyze: vi.fn(),
      cancel: vi.fn(async () => ({ success: true })),
      onQuestion: vi.fn(() => () => {}),
      answer: vi.fn(async () => ({ success: true })),
      createTasks: vi.fn(async (_p: string, _b: string, tasks: BriefTaskDraft[]) => ({
        success: true,
        data: tasks.map((t, i) => ({ key: t.key, taskId: `id-${i}`, specId: `0${20 + i}-${t.key.toLowerCase()}` })),
      })),
      onProgress: vi.fn((cb: (e: BriefProgressEvent) => void) => {
        progress = cb;
        return () => {
          progress = null;
        };
      }),
    };
    (window as unknown as { electronAPI: { brief: typeof brief } }).electronAPI = { brief };
  });

  afterEach(cleanup);

  const row = (key: string) => screen.getByTestId(`brief-task-${key}`);

  it('unchecking a task drops it and the dependencies on it from what is created', async () => {
    render(<BriefImportDialog projectId="p1" open onOpenChange={noop} initialProposal={proposal} />);

    fireEvent.click(within(row('T1')).getByRole('checkbox'));

    // The unchecked row says who loses it; the dependents say what they lose
    expect(within(row('T1')).getByText(/tasks:briefImport.review.dependentsLose .*"keys":"T2, T3"/)).toBeInTheDocument();
    expect(within(row('T2')).getByText(/tasks:briefImport.review.losesDependency .*"keys":"T1"/)).toBeInTheDocument();

    // Start order is recomputed from what is created
    const waves = screen.getByTestId('brief-waves');
    expect(waves.textContent).toContain('T2');
    expect(waves.textContent).not.toContain('T1');

    // Queue off, then create
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: /tasks:briefImport.review.create / }));

    await waitFor(() => expect(brief.createTasks).toHaveBeenCalledTimes(1));
    const [projectId, briefId, sent, options] = brief.createTasks.mock.calls[0];
    expect(projectId).toBe('p1');
    expect(briefId).toBe('b-1');
    expect(options).toEqual({ queue: false });
    expect((sent as BriefTaskDraft[]).map((t) => [t.key, t.dependsOn])).toEqual([
      ['T2', []],
      ['T3', []],
      ['T4', ['T2', 'T3']],
      ['T5', []],
    ]);

    // Done: spec ids from the result, board reloaded
    expect(await screen.findByText('020-t2')).toBeInTheDocument();
    expect(screen.getByText(/tasks:briefImport.done.title .*"count":4/)).toBeInTheDocument();
    expect(loadTasks).toHaveBeenCalledWith('p1');
  });

  it('sends edited titles, enums and criteria', async () => {
    render(<BriefImportDialog projectId="p1" open onOpenChange={noop} initialProposal={proposal} />);

    fireEvent.change(screen.getByLabelText(/tasks:briefImport.review.titleLabel .*"key":"T3"/), { target: { value: 'PDF rendering' } });
    fireEvent.click(within(row('T3')).getByRole('button', { name: /tasks:briefImport.review.expand/ }));
    fireEvent.click(within(row('T3')).getByRole('button', { name: 'tasks:briefImport.review.addCriterion' }));
    const criteria = within(row('T3')).getAllByLabelText(/tasks:briefImport.review.criterionLabel/);
    fireEvent.change(criteria[1], { target: { value: 'Given a PDF, when opened, then totals match.' } });
    fireEvent.click(within(row('T3')).getByRole('button', { name: /tasks:briefImport.review.removeCriterion .*"index":1/ }));

    fireEvent.click(screen.getByRole('button', { name: /tasks:briefImport.review.create / }));
    await waitFor(() => expect(brief.createTasks).toHaveBeenCalled());
    const sent = brief.createTasks.mock.calls[0][2] as BriefTaskDraft[];
    const t3 = sent.find((t) => t.key === 'T3');
    expect(t3?.title).toBe('PDF rendering');
    expect(t3?.acceptanceCriteria).toEqual(['Given a PDF, when opened, then totals match.']);
    expect(brief.createTasks.mock.calls[0][3]).toEqual({ queue: true });
  });

  it('blocks creating while a title is empty', () => {
    render(<BriefImportDialog projectId="p1" open onOpenChange={noop} initialProposal={proposal} />);
    fireEvent.change(screen.getByLabelText(/tasks:briefImport.review.titleLabel .*"key":"T2"/), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: /tasks:briefImport.review.create / })).toBeDisabled();
    expect(screen.getByText('tasks:briefImport.review.fixTitles')).toBeInTheDocument();
  });

  it('shows progress while analysing and the proposal when it arrives', async () => {
    let resolve: (v: unknown) => void = noop;
    brief.analyze.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<BriefImportDialog projectId="p1" open onOpenChange={noop} />);

    fireEvent.change(screen.getByLabelText('tasks:briefImport.input.textHeading'), { target: { value: 'Invoices please' } });
    fireEvent.click(screen.getByRole('button', { name: 'tasks:briefImport.input.analyse' }));
    expect(brief.analyze).toHaveBeenCalledWith('p1', { text: 'Invoices please', clarify: true });

    act(() => {
      progress?.({ projectId: 'other', message: 'not ours' });
      progress?.({ projectId: 'p1', message: 'Reading the brief' });
    });
    expect(screen.getByText('Reading the brief')).toBeInTheDocument();
    expect(screen.queryByText('not ours')).not.toBeInTheDocument();

    await act(async () => resolve({ success: true, data: proposal }));
    expect(await screen.findByText('Invoicing')).toBeInTheDocument();
    expect(screen.getByText('Which email provider?')).toBeInTheDocument();
  });

  it("shows the analyst's question, sends the answer, and can stop the questions", async () => {
    let ask: ((e: BriefQuestionEvent) => void) | null = null;
    brief.onQuestion.mockImplementation((cb: (e: BriefQuestionEvent) => void) => {
      ask = cb;
      return noop;
    });
    brief.analyze.mockImplementation(() => new Promise(noop));
    render(<BriefImportDialog projectId="p1" open onOpenChange={noop} />);
    fireEvent.change(screen.getByLabelText('tasks:briefImport.input.textHeading'), { target: { value: 'An app for my bakery' } });
    fireEvent.click(screen.getByRole('button', { name: 'tasks:briefImport.input.analyse' }));

    const question = { question: 'Who orders: walk-in customers or cafes?', header: 'Users', multiSelect: false, options: [{ label: 'Cafes (Recommended)', description: 'B2B orders' }, { label: 'Walk-in', description: 'Retail' }] };
    act(() => ask?.({ projectId: 'p1', questionId: 'q1', questions: [question] }));
    expect(screen.getAllByText('Who orders: walk-in customers or cafes?').length).toBeGreaterThan(0);
    const send = screen.getByRole('button', { name: 'tasks:briefImport.question.send' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Cafes/ }));
    fireEvent.click(send);
    await waitFor(() => expect(brief.answer).toHaveBeenCalledWith('p1', 'q1', { 'Who orders: walk-in customers or cafes?': 'Cafes (Recommended)' }, false));
    // The answered question stays listed with its answer
    expect(screen.getByText('Cafes (Recommended)')).toBeInTheDocument();

    act(() => ask?.({ projectId: 'p1', questionId: 'q2', questions: [{ ...question, question: 'Delivery or pickup?' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'tasks:briefImport.question.stop' }));
    await waitFor(() => expect(brief.answer).toHaveBeenCalledWith('p1', 'q2', null, true));
  });

  it('cancel stops the analyst and returns to the input; errors offer Retry', async () => {
    brief.analyze.mockImplementationOnce(() => new Promise(noop));
    render(<BriefImportDialog projectId="p1" open onOpenChange={noop} />);
    fireEvent.change(screen.getByLabelText('tasks:briefImport.input.textHeading'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'tasks:briefImport.input.analyse' }));
    fireEvent.click(screen.getByRole('button', { name: 'tasks:briefImport.analysing.cancel' }));
    await waitFor(() => expect(brief.cancel).toHaveBeenCalledWith('p1'));
    expect(await screen.findByRole('button', { name: 'tasks:briefImport.input.analyse' })).toBeInTheDocument();

    brief.analyze.mockResolvedValueOnce({ success: false, error: 'No API key' });
    fireEvent.click(screen.getByRole('button', { name: 'tasks:briefImport.input.analyse' }));
    expect(await screen.findByText('No API key')).toBeInTheDocument();
    brief.analyze.mockResolvedValueOnce({ success: true, data: proposal });
    fireEvent.click(screen.getByRole('button', { name: 'tasks:briefImport.errors.retry' }));
    expect(await screen.findByText('Invoicing')).toBeInTheDocument();
  });
});
