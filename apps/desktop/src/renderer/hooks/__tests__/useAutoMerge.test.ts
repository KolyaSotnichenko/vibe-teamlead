import { describe, expect, it } from 'vitest';
import { autoMergeEnabled } from '../useAutoMerge';

const project = (autoMerge?: boolean) => ({ id: 'p', settings: autoMerge === undefined ? {} : { autoMerge } }) as never;
const task = (sourceType?: string) => ({ id: 't', projectId: 'p', metadata: sourceType ? { sourceType } : {} }) as never;

describe('autoMergeEnabled', () => {
  it('is off by default for a manual task when the project switch is off', () => {
    expect(autoMergeEnabled(project(false), task('manual'))).toBe(false);
    expect(autoMergeEnabled(project(undefined), task())).toBe(false);
  });

  it('follows the project switch for ordinary tasks', () => {
    expect(autoMergeEnabled(project(true), task('manual'))).toBe(true);
  });

  it('always merges a deploy task by itself, even with the project switch off', () => {
    expect(autoMergeEnabled(project(false), task('deploy'))).toBe(true);
    expect(autoMergeEnabled(project(undefined), task('deploy'))).toBe(true);
  });
});
