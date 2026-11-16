import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {} }));
const root = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../project-store', () => ({
  projectStore: { getProject: (id: string) => (id === 'p' ? { id: 'p', path: root.dir, autoBuildPath: '.vibe-teamlead' } : undefined), invalidateTasksCache: vi.fn() },
}));
const createTask = vi.hoisted(() => vi.fn(async (_p: unknown, title: string, _d?: string, _m?: unknown) => ({ id: `id-${title}`, specId: `spec-${title}`, specsPath: undefined })));
vi.mock('../task/crud-handlers', () => ({ createTaskInProject: createTask }));
const persist = vi.hoisted(() => vi.fn());
vi.mock('../task/plan-file-utils', () => ({ persistPlanStatus: persist }));
vi.mock('../../settings-utils', () => ({ readSettingsFile: () => ({}) }));
vi.mock('../../ai/runners/brief-import', () => ({
  analyzeBrief: vi.fn(),
  briefsRoot: () => join(root.dir, 'briefs'),
  taskDescription: (draft: { title: string }) => `About ${draft.title}`,
  readProposalQuestions: () => [],
  openQuestionsByTask: () => new Map(),
  BriefError: Error,
}));

import { createBriefTasks } from '../brief-handlers';

const draft = (key: string, title: string, dependsOn: string[] = []) => ({ key, title, dependsOn, category: 'feature', complexity: 'simple', priority: 'medium', acceptanceCriteria: [] }) as never;

beforeEach(() => {
  root.dir = mkdtempSync(join(tmpdir(), 'vt-brief-'));
  mkdirSync(join(root.dir, 'briefs', 'b1'), { recursive: true });
  writeFileSync(join(root.dir, 'briefs', 'b1', 'brief.md'), '# brief');
  createTask.mockClear();
  persist.mockClear();
});
afterEach(() => rmSync(root.dir, { recursive: true, force: true }));

// The Telegram bot's "Create N tasks" runs what the brief dialog's Create runs
describe('createBriefTasks', () => {
  it('creates the drafts in dependency order with their brief and dependencies', async () => {
    const result = await createBriefTasks('p', 'b1', [draft('T2', 'Two', ['T1']), draft('T1', 'One')], { queue: false });
    expect(result).toEqual({ success: true, data: [{ key: 'T1', taskId: 'id-One', specId: 'spec-One' }, { key: 'T2', taskId: 'id-Two', specId: 'spec-Two' }] });
    expect(createTask.mock.calls[1][3]).toMatchObject({ sourceType: 'brief', briefId: 'b1', briefTaskKey: 'T2', dependencies: ['spec-One'] });
    expect(persist).not.toHaveBeenCalled();
  });

  it('refuses an unknown project or brief', async () => {
    expect((await createBriefTasks('x', 'b1', [draft('T1', 'One')], { queue: false })).success).toBe(false);
    expect((await createBriefTasks('p', 'nope', [draft('T1', 'One')], { queue: false })).success).toBe(false);
  });
});
