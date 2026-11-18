import { describe, expect, it, vi } from 'vitest';

import { cloudArchitectureDir, cloudRedrawAfterMerge, type AfterMergeDeps } from '../after-merge';

function deps(over: Partial<AfterMergeDeps> = {}): AfterMergeDeps & { redraw: ReturnType<typeof vi.fn>; gitCalls: string[][] } {
  const gitCalls: string[][] = [];
  const redraw = vi.fn(async () => ({ lastAttempt: { at: 'now', commit: 'm1', status: 'drawn' as const } }));
  return {
    enabled: () => true,
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'm1', raw: 'm1\n', output: '' };
      if (args.includes('diff')) return { ok: true, stdout: '', raw: 'infra/main.tf\0src/a.ts\0', output: '' };
      return { ok: true, stdout: '', raw: '', output: '' };
    },
    redraw,
    gitCalls,
    ...over,
  } as AfterMergeDeps & { redraw: ReturnType<typeof vi.fn>; gitCalls: string[][] };
}

describe('cloudRedrawAfterMerge', () => {
  it("redraws from the merge commit with the files the merge brought in", async () => {
    const d = deps();
    await cloudRedrawAfterMerge({ projectPath: '/p', baseBranch: 'main', taskId: 't1', taskTitle: 'Add storage' }, d);
    expect(d.gitCalls[0]).toEqual(['rev-parse', '--verify', '--quiet', 'main^{commit}']);
    expect(d.gitCalls[1]).toEqual(['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', 'm1^1', 'm1']);
    expect(d.redraw).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: '/p', commit: 'm1', changedFiles: ['infra/main.tf', 'src/a.ts'], storeDir: cloudArchitectureDir('/p'), taskId: 't1', taskTitle: 'Add storage' }),
    );
  });

  it('does nothing when the setting is off', async () => {
    const d = deps({ enabled: () => false });
    await cloudRedrawAfterMerge({ projectPath: '/p', baseBranch: 'main' }, d);
    expect(d.gitCalls).toEqual([]);
    expect(d.redraw).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const d = deps({ git: async () => { throw new Error('boom'); } });
    await expect(cloudRedrawAfterMerge({ projectPath: '/p', baseBranch: 'main' }, d)).resolves.toBeUndefined();
  });
});
