import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunClaudeTask = vi.fn();

vi.mock('../../../claude-code/task', () => ({
  runClaudeTask: (...args: unknown[]) => mockRunClaudeTask(...args),
}));

import { BatchProcessor } from '../batch-processor';
import type { GitHubIssue } from '../duplicate-detector';

const issue = (number: number, title = `Issue ${number}`) =>
  ({ number, title, body: 'body', labels: [] }) as unknown as GitHubIssue;

describe('BatchProcessor', () => {
  beforeEach(() => {
    mockRunClaudeTask.mockReset();
  });

  it('groups issues via a tool-less Claude task using the configured model', async () => {
    mockRunClaudeTask.mockResolvedValue({
      text: '```json\n{"batches":[{"issue_numbers":[1,2],"theme":"Auth","reasoning":"login","confidence":0.9},{"issue_numbers":[3],"theme":"UI","reasoning":"other","confidence":0.8}]}\n```',
    });

    const processor = new BatchProcessor({ model: 'haiku', thinkingLevel: 'medium' });
    const batches = await processor.groupIssues([issue(1), issue(2), issue(3)]);

    expect(batches).toEqual([
      { issueNumbers: [1, 2], theme: 'Auth', reasoning: 'login', confidence: 0.9 },
      { issueNumbers: [3], theme: 'UI', reasoning: 'other', confidence: 0.8 },
    ]);
    const opts = mockRunClaudeTask.mock.calls[0][0];
    expect(opts).toMatchObject({ model: 'haiku', thinkingLevel: 'medium' });
    expect(opts.tools).toBeUndefined();
    expect(opts.prompt).toContain('#1: Issue 1');
  });

  it('does not call Claude for a single issue', async () => {
    const batches = await new BatchProcessor().groupIssues([issue(9, 'Only')]);
    expect(mockRunClaudeTask).not.toHaveBeenCalled();
    expect(batches[0]).toMatchObject({ issueNumbers: [9], theme: 'Only' });
  });

  it('falls back when the task fails', async () => {
    mockRunClaudeTask.mockRejectedValue(new Error('auth'));
    const batches = await new BatchProcessor().groupIssues([issue(1), issue(2)]);
    expect(batches.flatMap((b) => b.issueNumbers).sort()).toEqual([1, 2]);
  });

  it('processBatches reports progress and runs the processor per batch', async () => {
    mockRunClaudeTask.mockResolvedValue({
      text: '{"batches":[{"issue_numbers":[1,2],"theme":"T","reasoning":"r","confidence":1}]}',
    });
    const onProgress = vi.fn();
    const results = await new BatchProcessor().processBatches(
      [issue(1), issue(2)],
      async (b) => b.issues.length,
      onProgress,
    );
    expect(results).toEqual([expect.objectContaining({ success: true, result: 2, issues: [1, 2] })]);
    expect(onProgress.mock.calls[0][0].phase).toBe('grouping');
  });
});
