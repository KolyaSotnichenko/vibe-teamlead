import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findTaskAndProject: vi.fn(), findTaskWorktree: vi.fn() }));
vi.mock('../shared', () => ({ findTaskAndProject: mocks.findTaskAndProject }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: mocks.findTaskWorktree }));

import { resolveSpecDir } from '../workspace-handlers';

describe('resolveSpecDir', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'ws-proj-'));
  const task = { specId: '001-scaffold', specsPath: path.join(project, '.vibe-teamlead', 'specs', '001-scaffold') };
  mocks.findTaskAndProject.mockReturnValue({ task, project: { path: project, autoBuildPath: '.vibe-teamlead' } });

  it("reads the worktree's spec dir while the task builds there (QA and Security QA write it)", () => {
    const worktree = path.join(project, '.vibe-teamlead', 'worktrees', 'tasks', '001-scaffold');
    const worktreeSpec = path.join(worktree, '.vibe-teamlead', 'specs', '001-scaffold');
    mkdirSync(worktreeSpec, { recursive: true });
    mocks.findTaskWorktree.mockReturnValue(worktree);
    expect(resolveSpecDir('t1')).toBe(worktreeSpec);
  });

  it("uses the project's spec dir without a worktree (before the build, after merge)", () => {
    mocks.findTaskWorktree.mockReturnValue(null);
    expect(resolveSpecDir('t1')).toBe(task.specsPath);
  });
});
