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

vi.mock('../../../prompts/prompt-loader', () => ({
  loadPrompt: (name: string) => `PROMPT:${name}`,
}));

import { ClaudeTaskError } from '../../../claude-code/task';
import type { SessionResult, StreamEvent } from '../../../session/types';
import { MergeVerdict, ParallelOrchestratorReviewer } from '../parallel-orchestrator';
import type { PRContext } from '../pr-review-engine';

function makeContext(): PRContext {
  return {
    prNumber: 7,
    title: 'Fix bug',
    description: 'Fixes a bug',
    author: 'bob',
    baseBranch: 'main',
    headBranch: 'fix',
    state: 'open',
    changedFiles: [{ path: 'src/b.ts', additions: 3, deletions: 1, status: 'modified', patch: '+y' }],
    diff: '+y',
    diffTruncated: false,
    repoStructure: '',
    relatedFiles: [],
    commits: [],
    labels: [],
    totalAdditions: 3,
    totalDeletions: 1,
    aiBotComments: [],
  };
}

const rawFinding = {
  id: 'x',
  severity: 'high',
  category: 'security',
  title: 'SQL injection',
  description: 'unsanitized input',
  file: 'src/b.ts',
  line: 10,
  suggestedFix: 'use params',
  fixable: true,
  evidence: 'query(input)',
};

type Opts = {
  systemPrompt: string;
  agentType?: string;
  tools?: string[];
  onEvent?: (e: StreamEvent) => void;
};

describe('ParallelOrchestratorReviewer', () => {
  beforeEach(() => {
    mockRunClaudeTask.mockReset();
  });

  it('runs 4 specialists in parallel with read tools in the project dir, then synthesis and validation', async () => {
    mockRunClaudeTask.mockImplementation(async (opts: Opts) => {
      if (opts.systemPrompt === 'PROMPT:github/pr_security_agent') {
        opts.onEvent?.({ type: 'tool-call', toolName: 'Read', toolCallId: '1', args: {} });
        opts.onEvent?.({
          type: 'step-finish',
          stepNumber: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        } as StreamEvent);
        return { text: '', output: { findings: [rawFinding], summary: 'found one' } };
      }
      if (opts.systemPrompt.startsWith('PROMPT:github/pr_') && opts.agentType !== 'pr_finding_validator') {
        return { text: '', output: { findings: [], summary: 'clean' } };
      }
      if (opts.systemPrompt === 'You are a senior code review orchestrator.') {
        return {
          text: '',
          output: {
            verdict: 'needs_revision',
            verdictReasoning: 'SQL injection',
            keptFindingIds: [],
            removedFindingIds: [],
            removalReasons: {},
          },
        };
      }
      // finding validator: confirm everything it was asked about
      return { text: '', output: { validations: [] } };
    });

    const progress = vi.fn();
    const reviewer = new ParallelOrchestratorReviewer(
      { repo: 'o/r', projectDir: '/repo', model: 'opus', thinkingLevel: 'high' },
      progress,
    );
    const result = await reviewer.review(makeContext());

    const specialistCalls = mockRunClaudeTask.mock.calls
      .map((c) => c[0])
      .filter((o) => String(o.agentType).endsWith('_specialist'));
    expect(specialistCalls.map((o) => o.agentType).sort()).toEqual([
      'pr_codebase_fit_specialist',
      'pr_logic_specialist',
      'pr_quality_specialist',
      'pr_security_specialist',
    ]);
    for (const o of specialistCalls) {
      expect(o.tools).toEqual(['Read', 'Glob', 'Grep']);
      expect(o.cwd).toBe('/repo');
      expect(o.model).toBe('opus');
      expect(o.thinkingLevel).toBe('high');
      expect(o.outputSchema).toBeDefined();
    }

    const validator = mockRunClaudeTask.mock.calls.map((c) => c[0]).find((o) => o.agentType === 'pr_finding_validator');
    expect(validator.cwd).toBe('/repo');
    expect(validator.tools).not.toContain('SpawnSubagent');
    expect(validator.tools).toContain('Read');

    expect(result.verdict).toBe(MergeVerdict.NEEDS_REVISION);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe('SQL injection');
    expect(result.agentsInvoked).toEqual(['security', 'quality', 'logic', 'codebase-fit']);

    const messages = progress.mock.calls.map((c) => c[0].message as string);
    expect(messages.some((m) => m.includes('[Specialist:security] Step 1: 1 tool call(s) — Read'))).toBe(true);
    expect(messages.some((m) => m.includes('[Specialist:security] Complete — 1 finding'))).toBe(true);
    expect(progress.mock.calls.at(-1)?.[0].phase).toBe('complete');
  });

  it('approves without synthesis when no specialist finds anything', async () => {
    mockRunClaudeTask.mockResolvedValue({ text: '', output: { findings: [], summary: 'clean' } });
    const reviewer = new ParallelOrchestratorReviewer({ repo: 'o/r', projectDir: '/repo' });
    const result = await reviewer.review(makeContext());
    expect(result.verdict).toBe(MergeVerdict.READY_TO_MERGE);
    expect(mockRunClaudeTask).toHaveBeenCalledTimes(4);
    expect(mockRunClaudeTask.mock.calls[0][0]).toMatchObject({ model: 'sonnet', thinkingLevel: 'medium' });
  });

  it('reports specialist failures with the session outcome and keeps going', async () => {
    mockRunClaudeTask.mockImplementation(async (opts: Opts) => {
      if (opts.agentType === 'pr_security_specialist') {
        throw new ClaudeTaskError('rate limit', { outcome: 'rate_limited' } as SessionResult);
      }
      return { text: '', output: { findings: [], summary: 'clean' } };
    });
    const progress = vi.fn();
    const reviewer = new ParallelOrchestratorReviewer({ repo: 'o/r', projectDir: '/repo' }, progress);
    const result = await reviewer.review(makeContext());

    expect(result.verdict).toBe(MergeVerdict.READY_TO_MERGE);
    const messages = progress.mock.calls.map((c) => c[0].message as string);
    expect(messages).toContain('[Specialist:security] Failed [rate_limited]: rate limit');
  });

  it('falls back to a severity-based verdict when synthesis fails and keeps findings when validation fails', async () => {
    mockRunClaudeTask.mockImplementation(async (opts: Opts) => {
      if (opts.agentType === 'pr_security_specialist') {
        return { text: '', output: { findings: [{ ...rawFinding, severity: 'critical' }], summary: '' } };
      }
      if (String(opts.agentType).endsWith('_specialist')) {
        return { text: '', output: { findings: [], summary: '' } };
      }
      throw new Error('synthesis/validator down');
    });
    const reviewer = new ParallelOrchestratorReviewer({ repo: 'o/r', projectDir: '/repo' });
    const result = await reviewer.review(makeContext());
    expect(result.verdict).toBe(MergeVerdict.BLOCKED);
    expect(result.findings).toHaveLength(1);
    expect(result.blockers).toEqual(['security: SQL injection']);
  });
});
