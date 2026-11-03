import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunClaudeTask = vi.fn();

vi.mock('../../../claude-code/task', () => ({
  runClaudeTask: (...args: unknown[]) => mockRunClaudeTask(...args),
}));

import { type MRContext, MRReviewEngine, MergeVerdict } from '../mr-review-engine';

const context: MRContext = {
  mrIid: 12,
  title: 'Refactor',
  description: 'Refactors things',
  author: 'carol',
  sourceBranch: 'refactor',
  targetBranch: 'main',
  changedFiles: [{ new_path: 'src/c.ts', additions: 5, deletions: 5 }],
  diff: '+z',
  totalAdditions: 5,
  totalDeletions: 5,
};

describe('MRReviewEngine', () => {
  beforeEach(() => {
    mockRunClaudeTask.mockReset();
  });

  it('runs a single tool-less Claude task and parses the JSON review', async () => {
    mockRunClaudeTask.mockResolvedValue({
      text: '```json\n{"summary":"Looks risky","verdict":"needs_revision","findings":[{"severity":"high","category":"security","title":"Leak","description":"d","file":"src/c.ts","line":4}]}\n```',
    });
    const progress = vi.fn();
    const abort = new AbortController();
    const engine = new MRReviewEngine({ model: 'opus', thinkingLevel: 'high' } as never, progress);

    const result = await engine.runReview(context, abort.signal);

    expect(result.verdict).toBe(MergeVerdict.NEEDS_REVISION);
    expect(result.summary).toBe('Looks risky');
    expect(result.findings).toHaveLength(1);
    expect(result.blockers).toEqual(['Leak (src/c.ts:4)']);
    const opts = mockRunClaudeTask.mock.calls[0][0];
    expect(opts).toMatchObject({ model: 'opus', thinkingLevel: 'high', abortSignal: abort.signal });
    expect(opts.tools).toBeUndefined();
    expect(opts.prompt).toContain('Merge Request !12');
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'analyzing', mrIid: 12 }));
  });

  it('returns a parse-failure summary for unparseable output', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: 'not json at all' });
    const engine = new MRReviewEngine({} as never);
    const result = await engine.runReview(context);
    expect(result.verdict).toBe(MergeVerdict.MERGE_WITH_CHANGES);
    expect(result.summary).toContain('failed to parse');
    expect(mockRunClaudeTask.mock.calls[0][0]).toMatchObject({ model: 'sonnet', thinkingLevel: 'medium' });
  });

  it('wraps task failures', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('auth failed'));
    const engine = new MRReviewEngine({} as never);
    await expect(engine.runReview(context)).rejects.toThrow('MR review failed: auth failed');
  });
});
