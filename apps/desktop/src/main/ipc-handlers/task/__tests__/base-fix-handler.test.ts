import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { handleBaseFailures } from '../base-fix-handler';

const failures = [{ command: 'pnpm run test', tail: 'FAIL apps/api/test/database/migrations.e2e-spec.ts' }];

function setup(sourceType?: string) {
  const project = { id: 'p1', path: mkdtempSync(path.join(tmpdir(), 'vtl-basefix-h-')), settings: { mainBranch: 'main' } };
  const tasks: Array<{ id: string; specId: string; status: string; metadata?: { sourceType?: string } }> = [
    { id: '031-theme', specId: '031-theme', status: 'ai_review', metadata: sourceType ? { sourceType } : {} },
  ];
  let n = 56;
  const deps = {
    findTaskAndProject: (id: string) => ({ task: tasks.find((t) => t.id === id), project }),
    getTasks: () => tasks,
    createTask: vi.fn(async (_p: unknown, title: string, _d: string, metadata: Record<string, unknown>) => {
      const specId = `0${n++}-fix-main`;
      tasks.push({ id: specId, specId, status: 'backlog', metadata: { sourceType: metadata.sourceType as string } });
      return { id: specId, specId, title };
    }),
    startTask: vi.fn(async () => {}),
  };
  return { deps, tasks };
}

describe('a check failing on main too', () => {
  it('creates one urgent task to fix main and starts it at once', async () => {
    const { deps } = setup();
    await handleBaseFailures(deps as never, '031-theme', { failures, baseCommit: 'b0f1e2d' });
    expect(deps.createTask).toHaveBeenCalledWith(expect.anything(), 'Fix main: `pnpm run test` fails', expect.stringContaining('migrations.e2e-spec.ts'), expect.objectContaining({ sourceType: 'base-fix', priority: 'urgent', category: 'bug_fix' }));
    expect(deps.startTask).toHaveBeenCalledWith('056-fix-main');
  });

  it('does nothing while that task is open, even when tasks report it at the same moment', async () => {
    const { deps, tasks } = setup();
    tasks.push({ id: '032-other', specId: '032-other', status: 'ai_review' });
    await Promise.all([
      handleBaseFailures(deps as never, '031-theme', { failures, baseCommit: 'b0' }),
      handleBaseFailures(deps as never, '032-other', { failures, baseCommit: 'b0' }),
    ]);
    await handleBaseFailures(deps as never, '031-theme', { failures, baseCommit: 'b0' });
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(deps.startTask).toHaveBeenCalledTimes(1);
  });

  it('makes a new one when main fails again after the fix was merged', async () => {
    const { deps, tasks } = setup();
    await handleBaseFailures(deps as never, '031-theme', { failures, baseCommit: 'b0' });
    tasks.find((t) => t.specId === '056-fix-main')!.status = 'done';
    await handleBaseFailures(deps as never, '031-theme', { failures, baseCommit: 'b1' });
    expect(deps.createTask).toHaveBeenCalledTimes(2);
  });

  it('the fix task itself reports nothing: it is the one fixing it', async () => {
    const { deps } = setup('base-fix');
    await handleBaseFailures(deps as never, '031-theme', { failures, baseCommit: 'b0' });
    expect(deps.createTask).not.toHaveBeenCalled();
  });
});
