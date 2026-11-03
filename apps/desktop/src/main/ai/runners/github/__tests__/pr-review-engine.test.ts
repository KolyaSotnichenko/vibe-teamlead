import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunClaudeTask = vi.fn();

vi.mock('../../../claude-code/task', () => {
  class ClaudeTaskError extends Error {
    constructor(
      message: string,
      readonly session: { outcome: string },
    ) {
      super(message);
    }
  }
  return {
    runClaudeTask: (...args: unknown[]) => mockRunClaudeTask(...args),
    ClaudeTaskError,
  };
});

import { ClaudeTaskError } from '../../../claude-code/task';
import type { SessionResult } from '../../../session/types';
import {
  type PRContext,
  ReviewPass,
  deduplicateFindings,
  runMultiPassReview,
  runReviewPass,
} from '../pr-review-engine';

function makeContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    prNumber: 42,
    title: 'Add feature',
    description: 'Adds a feature',
    author: 'alice',
    baseBranch: 'main',
    headBranch: 'feat',
    state: 'open',
    changedFiles: [{ path: 'src/a.ts', additions: 10, deletions: 2, status: 'modified', patch: '+x' }],
    diff: '+x',
    diffTruncated: false,
    repoStructure: '',
    relatedFiles: [],
    commits: [],
    labels: [],
    totalAdditions: 10,
    totalDeletions: 2,
    aiBotComments: [],
    ...overrides,
  };
}

const finding = (id: string, title = `Finding ${id}`) => ({
  id,
  severity: 'high',
  category: 'security',
  title,
  description: 'desc',
  file: 'src/a.ts',
  line: 3,
  suggestedFix: '',
  fixable: false,
  evidence: '',
});

/** Route mocked tasks by the pass prompt. */
function routeByPrompt() {
  mockRunClaudeTask.mockImplementation(async ({ prompt }: { prompt: string }) => {
    if (prompt.includes('quick scan')) {
      return { text: '', output: { complexity: 'low', riskAreas: [], verdict: 'approve', summary: 's' } };
    }
    if (prompt.includes('security-focused')) return { text: '', output: { findings: [finding('SEC-1')] } };
    if (prompt.includes('code quality reviewer')) return { text: '', output: { findings: [finding('QLT-1')] } };
    if (prompt.includes('structural issues')) return { text: '', output: { issues: [] } };
    return { text: '', output: { findings: [] } };
  });
}

describe('pr-review-engine', () => {
  beforeEach(() => {
    mockRunClaudeTask.mockReset();
  });

  it('runs the quick scan as a tool-less structured task with the configured model', async () => {
    mockRunClaudeTask.mockResolvedValue({
      text: '',
      output: { complexity: 'high', riskAreas: ['auth'], verdict: 'needs_review', summary: 's' },
    });

    const result = await runReviewPass(ReviewPass.QUICK_SCAN, makeContext(), {
      repo: 'o/r',
      model: 'opus',
      thinkingLevel: 'high',
    });

    expect(result).toMatchObject({ complexity: 'high', riskAreas: ['auth'] });
    const opts = mockRunClaudeTask.mock.calls[0][0];
    expect(opts.model).toBe('opus');
    expect(opts.thinkingLevel).toBe('high');
    expect(opts.outputSchema).toBeDefined();
    expect(opts.tools).toBeUndefined();
    expect(opts.prompt).toContain('Pull Request #42');
  });

  it('defaults to sonnet / medium thinking', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '', output: { findings: [] } });
    await runReviewPass(ReviewPass.SECURITY, makeContext(), { repo: 'o/r' });
    expect(mockRunClaudeTask.mock.calls[0][0]).toMatchObject({ model: 'sonnet', thinkingLevel: 'medium' });
  });

  it('unwraps findings from structured output', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '', output: { findings: [finding('SEC-1')] } });
    const result = await runReviewPass(ReviewPass.SECURITY, makeContext(), { repo: 'o/r' });
    expect(result).toHaveLength(1);
  });

  it('falls back to empty results when the session completed without valid output', async () => {
    mockRunClaudeTask.mockRejectedValue(
      new ClaudeTaskError('no output', { outcome: 'completed' } as SessionResult),
    );
    const scan = await runReviewPass(ReviewPass.QUICK_SCAN, makeContext(), { repo: 'o/r' });
    expect(scan).toEqual({ complexity: 'low', riskAreas: [] });
  });

  it('propagates auth failures', async () => {
    mockRunClaudeTask.mockRejectedValue(
      new ClaudeTaskError('bad key', { outcome: 'auth_failure' } as SessionResult),
    );
    await expect(runReviewPass(ReviewPass.SECURITY, makeContext(), { repo: 'o/r' })).rejects.toThrow('bad key');
  });

  it('runMultiPassReview runs passes in parallel, merges findings and reports progress', async () => {
    routeByPrompt();
    const progress = vi.fn();

    const result = await runMultiPassReview(makeContext(), { repo: 'o/r' }, progress);

    // quick scan + security + quality + structural (no AI comments, no deep analysis)
    expect(mockRunClaudeTask).toHaveBeenCalledTimes(4);
    expect(result.findings.map((f) => f.id).sort()).toEqual(['QLT-1', 'SEC-1']);
    expect(result.structuralIssues).toEqual([]);
    expect(result.scanResult.verdict).toBe('approve');
    const phases = progress.mock.calls.map((c) => c[0].phase);
    expect(phases).toEqual(expect.arrayContaining(['quick_scan', 'security', 'quality', 'structural', 'dedup']));
    expect(progress.mock.calls.every((c) => c[0].prNumber === 42)).toBe(true);
  });

  it('runMultiPassReview tolerates a failing parallel pass', async () => {
    routeByPrompt();
    const base = mockRunClaudeTask.getMockImplementation() as (opts: { prompt: string }) => unknown;
    mockRunClaudeTask.mockImplementation(async (opts: { prompt: string }) => {
      if (opts.prompt.includes('security-focused')) throw new Error('boom');
      return base(opts);
    });

    const result = await runMultiPassReview(makeContext(), { repo: 'o/r' });
    expect(result.findings.map((f) => f.id)).toEqual(['QLT-1']);
  });

  it('deduplicateFindings removes duplicates by file/line/title', () => {
    const a = finding('A', 'Same') as never;
    const b = finding('B', 'same ') as never;
    expect(deduplicateFindings([a, b])).toHaveLength(1);
  });
});
