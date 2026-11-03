import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunClaudeTask = vi.fn();

vi.mock('../../../claude-code/task', () => ({
  runClaudeTask: (...args: unknown[]) => mockRunClaudeTask(...args),
}));

import { type GitHubIssue, TriageCategory, triageBatchIssues, triageSingleIssue } from '../triage-engine';

const issue = (number: number): GitHubIssue => ({
  number,
  title: `Issue ${number}`,
  body: 'body',
  author: { login: 'u' },
  createdAt: '2026-01-01',
  labels: [],
});

const output = {
  category: 'bug',
  confidence: 0.9,
  labels_to_add: ['bug'],
  labels_to_remove: [],
  is_duplicate: false,
  duplicate_of: null,
  is_spam: false,
  is_feature_creep: false,
  suggested_breakdown: [],
  priority: 'high',
  comment: null,
};

describe('triage-engine', () => {
  beforeEach(() => {
    mockRunClaudeTask.mockReset();
  });

  it('maps structured output to a TriageResult', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '', output });
    const result = await triageSingleIssue(issue(1), [issue(1)], { repo: 'o/r', model: 'haiku' });

    expect(result).toMatchObject({
      issueNumber: 1,
      repo: 'o/r',
      category: TriageCategory.BUG,
      labelsToAdd: ['bug'],
      priority: 'high',
    });
    const opts = mockRunClaudeTask.mock.calls[0][0];
    expect(opts).toMatchObject({ model: 'haiku', thinkingLevel: 'low' });
    expect(opts.outputSchema).toBeDefined();
  });

  it('returns defaults when the task fails', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('rate limited'));
    const result = await triageSingleIssue(issue(2), [], { repo: 'o/r' });
    expect(result).toMatchObject({ issueNumber: 2, category: TriageCategory.FEATURE, confidence: 0 });
  });

  it('triageBatchIssues triages sequentially with progress', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '', output });
    const progress = vi.fn();
    const results = await triageBatchIssues([issue(1), issue(2)], { repo: 'o/r' }, progress);
    expect(results.map((r) => r.issueNumber)).toEqual([1, 2]);
    expect(progress.mock.calls.map((c) => c[0].progress)).toEqual([50, 100]);
  });
});
