import { describe, expect, it, vi } from 'vitest';
import { autoMergeEnabled } from '../useAutoMerge';

const project = (autoMerge?: boolean) => ({ id: 'p', settings: autoMerge === undefined ? {} : { autoMerge } }) as never;
const task = (sourceType?: string, specId = '001-x') => ({ id: 't', projectId: 'p', specId, metadata: sourceType ? { sourceType } : {} }) as never;
const ledger = (...specIds: string[]) => vi.fn(async (_projectId: string, specId: string) => specIds.includes(specId));

describe('autoMergeEnabled', () => {
  it('is off for a manual task while the project switch is off, and never asks the ledger', async () => {
    const isDeployTask = ledger();
    expect(await autoMergeEnabled(project(false), task('manual'), isDeployTask)).toBe(false);
    expect(await autoMergeEnabled(project(undefined), task(), isDeployTask)).toBe(false);
    expect(isDeployTask).not.toHaveBeenCalled();
  });

  it('follows the project switch for ordinary tasks', async () => {
    expect(await autoMergeEnabled(project(true), task('manual'), ledger())).toBe(true);
  });

  it('merges a deploy task the ledger created, even with the project switch off', async () => {
    const isDeployTask = ledger('001-x');
    expect(await autoMergeEnabled(project(false), task('deploy'), isDeployTask)).toBe(true);
    expect(isDeployTask).toHaveBeenCalledWith('p', '001-x');
  });

  it('does not merge a task that only says it is a deploy task: the ledger must hold it', async () => {
    expect(await autoMergeEnabled(project(false), task('deploy'), ledger('999-other'))).toBe(false);
  });

  it('does not merge without a project', async () => {
    expect(await autoMergeEnabled(undefined, task('deploy'), ledger('001-x'))).toBe(false);
  });
});
