import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {} }));
vi.mock('../../project-store', () => ({ projectStore: {} }));
vi.mock('../task/crud-handlers', () => ({ createTaskInProject: vi.fn() }));
vi.mock('../task/plan-file-utils', () => ({ persistPlanStatus: vi.fn() }));
vi.mock('../../ai/runners/brief-import', () => ({ analyzeBrief: vi.fn(), briefsRoot: vi.fn(), taskDescription: vi.fn(), BriefError: Error }));

import { orderByDependencies } from '../brief-handlers';

const t = (key: string, dependsOn: string[] = []) => ({ key, dependsOn }) as never;

describe('orderByDependencies', () => {
  it('creates prerequisites first and survives cycles', () => {
    expect(orderByDependencies([t('T3', ['T1', 'T2']), t('T1'), t('T2', ['T1'])]).map((x: { key: string }) => x.key)).toEqual(['T1', 'T2', 'T3']);
    expect(orderByDependencies([t('A', ['B']), t('B', ['A'])]).map((x: { key: string }) => x.key)).toEqual(['B', 'A']);
  });
});
