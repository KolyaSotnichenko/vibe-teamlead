import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunClaudeTask = vi.fn();

vi.mock('../../../claude-code/task', () => ({
  runClaudeTask: (...args: unknown[]) => mockRunClaudeTask(...args),
}));

import { MergeVerdict } from '../parallel-orchestrator';
import { type FollowupReviewContext, ParallelFollowupReviewer } from '../parallel-followup';

function makeContext(overrides: Partial<FollowupReviewContext> = {}): FollowupReviewContext {
  return {
    prNumber: 5,
    previousReview: {
      prNumber: 5,
      reviewId: 'r1',
      findings: [
        {
          id: 'OLD-1',
          severity: 'high',
          category: 'security',
          title: 'Old issue',
          description: 'old',
          file: 'a.ts',
          line: 1,
          fixable: false,
        },
        {
          id: 'OLD-2',
          severity: 'low',
          category: 'quality',
          title: 'Fixed issue',
          description: 'old',
          file: 'b.ts',
          line: 2,
          fixable: false,
        },
      ],
    },
    previousCommitSha: 'aaa',
    currentCommitSha: 'bbb',
    commitsSinceReview: [],
    filesChangedSinceReview: ['a.ts'],
    diffSinceReview: 'x'.repeat(200),
    contributorCommentsSinceReview: [],
    aiBotCommentsSinceReview: [],
    prReviewsSinceReview: [],
    ...overrides,
  };
}

describe('ParallelFollowupReviewer', () => {
  beforeEach(() => {
    mockRunClaudeTask.mockReset();
  });

  it('runs resolution-verifier and new-code-reviewer in parallel and merges their output', async () => {
    mockRunClaudeTask.mockImplementation(async ({ systemPrompt }: { systemPrompt: string }) => {
      if (systemPrompt.includes('resolution-verifier')) {
        return {
          text: '',
          output: {
            verifications: [
              { findingId: 'OLD-1', status: 'unresolved', evidence: 'still there' },
              { findingId: 'OLD-2', status: 'resolved', evidence: 'fixed' },
            ],
          },
        };
      }
      return {
        text: '',
        output: {
          findings: [
            {
              id: 'n',
              severity: 'medium',
              category: 'quality',
              title: 'New thing',
              description: 'd',
              file: 'a.ts',
              line: 9,
              suggestedFix: '',
              fixable: false,
              evidence: '',
            },
          ],
        },
      };
    });

    const progress = vi.fn();
    const reviewer = new ParallelFollowupReviewer({ repo: 'o/r', model: 'haiku', thinkingLevel: 'low' }, progress);
    const result = await reviewer.review(makeContext());

    expect(mockRunClaudeTask).toHaveBeenCalledTimes(2);
    for (const [opts] of mockRunClaudeTask.mock.calls) {
      expect(opts).toMatchObject({ model: 'haiku', thinkingLevel: 'low' });
      expect(opts.outputSchema).toBeDefined();
      expect(opts.tools).toBeUndefined();
    }
    expect(result.success).toBe(true);
    expect(result.resolvedFindings).toEqual(['OLD-2']);
    expect(result.unresolvedFindings).toEqual(['OLD-1']);
    expect(result.newFindingsSinceLastReview).toHaveLength(1);
    expect(result.findings.map((f) => f.title)).toEqual(['[UNRESOLVED] Old issue', 'New thing']);
    expect(result.verdict).toBe(MergeVerdict.NEEDS_REVISION);
    expect(progress.mock.calls.map((c) => c[0].phase)).toEqual(['orchestrating', 'finalizing']);
  });

  it('ignores a failing specialist', async () => {
    mockRunClaudeTask.mockImplementation(async ({ systemPrompt }: { systemPrompt: string }) => {
      if (systemPrompt.includes('resolution-verifier')) throw new Error('boom');
      return { text: '', output: { findings: [] } };
    });
    const reviewer = new ParallelFollowupReviewer({ repo: 'o/r' });
    const result = await reviewer.review(makeContext());
    expect(result.success).toBe(true);
    expect(result.verdict).toBe(MergeVerdict.READY_TO_MERGE);
  });

  it('blocks on merge conflicts', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '', output: { findings: [], verifications: [] } });
    const reviewer = new ParallelFollowupReviewer({ repo: 'o/r' });
    const result = await reviewer.review(makeContext({ hasMergeConflicts: true }));
    expect(result.verdict).toBe(MergeVerdict.BLOCKED);
    expect(result.blockers[0]).toContain('Merge Conflicts');
  });
});
