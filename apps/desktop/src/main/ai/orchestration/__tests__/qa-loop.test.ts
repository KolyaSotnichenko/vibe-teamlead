import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockUnlink = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

vi.mock('../../utils/json-repair', () => ({
  safeParseJson: (raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
}));

vi.mock('../qa-reports', () => ({
  DEFAULT_QA_ITERATIONS: 5,
  generateQAReport: vi.fn(() => '# QA Report'),
  mergeQAReport: vi.fn((agent: string | null, summary: string) => (agent ? `${agent}\n${summary}` : summary)),
  generateEscalationReport: vi.fn(() => '# Escalation Report'),
  generateManualTestPlan: vi.fn().mockResolvedValue('# Manual Test Plan'),
}));

// qa-loop.ts imports from '../schema' (relative to orchestration/)
// which resolves to src/main/ai/schema/index.ts
vi.mock('../../schema', () => ({
  QASignoffSchema: {},
  validateStructuredOutput: vi.fn((_data: unknown, _schema: unknown) => ({
    valid: true,
    data: _data,
  })),
}));

import { designIssues, gateIssues, QALoop } from '../qa-loop';
import type { QALoopConfig, QASessionRunConfig } from '../qa-loop';
import type { SessionResult } from '../../session/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SPEC_DIR = '/project/.vibe-teamlead/specs/001-feature';
const PROJECT_DIR = '/project';

function completedPlan(qaStatus?: 'approved' | 'rejected' | 'unknown') {
  const plan: Record<string, unknown> = {
    phases: [
      { subtasks: [{ status: 'completed' }, { status: 'completed' }] },
    ],
  };

  if (qaStatus === 'approved') {
    plan.qa_signoff = { status: 'approved', issues_found: [] };
  } else if (qaStatus === 'rejected') {
    plan.qa_signoff = { status: 'rejected', issues_found: [{ title: 'Test failure', type: 'critical' }] };
  }
  // qaStatus === 'unknown' → no qa_signoff key

  return JSON.stringify(plan);
}

function makeSessionResult(outcome: SessionResult['outcome']): SessionResult {
  return {
    outcome,
    error: outcome === 'error' ? new Error('session error') : undefined,
    totalSteps: 1,
    lastMessage: '',
  } as unknown as SessionResult;
}

function makeConfig(overrides: Partial<QALoopConfig> = {}): QALoopConfig {
  return {
    specDir: SPEC_DIR,
    projectDir: PROJECT_DIR,
    maxIterations: 5,
    generatePrompt: vi.fn().mockResolvedValue('system prompt'),
    runSession: vi.fn().mockResolvedValue(makeSessionResult('completed')),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QALoop', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockUnlink.mockReset().mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Build completeness guard
  // -------------------------------------------------------------------------

  it('returns error outcome when build is not complete', async () => {
    // Plan with a non-completed subtask
    const plan = JSON.stringify({
      phases: [{ subtasks: [{ status: 'pending' }] }],
    });

    // No QA_FIX_REQUEST.md either
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) return Promise.resolve(plan);
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig();
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('error');
  });

  // -------------------------------------------------------------------------
  // Already approved
  // -------------------------------------------------------------------------

  it('returns approved immediately when QA signoff is already "approved"', async () => {
    const plan = completedPlan('approved');

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) return Promise.resolve(plan);
      // QA_FIX_REQUEST.md does not exist
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig();
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(true);
    expect(outcome.totalIterations).toBe(0);
    // runSession should NOT have been called (short-circuit)
    expect(config.runSession).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // QA approved on first iteration
  // -------------------------------------------------------------------------

  it('approves on the first iteration when reviewer returns approved', async () => {
    // Let the reviewer run session set the approved state, then all subsequent reads return approved
    let sessionCallCount = 0;
    let _planReadCount = 0;

    const runSession = vi.fn().mockImplementation(async () => {
      sessionCallCount++;
      return makeSessionResult('completed');
    });

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        _planReadCount++;
        // Before the reviewer has run, return no signoff (build complete, no qa yet)
        if (sessionCallCount === 0) return Promise.resolve(completedPlan());
        // After the reviewer ran, return approved
        return Promise.resolve(completedPlan('approved'));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ runSession, maxIterations: 5 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(true);
    // Should have approved within the first few iterations
    expect(outcome.totalIterations).toBeGreaterThanOrEqual(1);
    // Only the reviewer should have been called (no fixer needed)
    const calls = runSession.mock.calls as Array<[QASessionRunConfig]>;
    expect(calls.every((c) => c[0].agentType === 'qa_reviewer')).toBe(true);
  });

  it("keeps the reviewer's qa_report.md (AC coverage table) when writing the final report", async () => {
    let sessionCallCount = 0;
    const agentReport = '# QA Validation Report\n\n| AC | Result |\n|----|--------|\n| AC-1 | PASS |\n';
    const runSession = vi.fn().mockImplementation(async () => {
      sessionCallCount++;
      return makeSessionResult('completed');
    });
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        return Promise.resolve(sessionCallCount === 0 ? completedPlan() : completedPlan('approved'));
      }
      if (path.endsWith('qa_report.md') && sessionCallCount > 0) return Promise.resolve(agentReport);
      return Promise.reject(new Error('ENOENT'));
    });

    const outcome = await new QALoop(makeConfig({ runSession, maxIterations: 5 })).run();
    expect(outcome.approved).toBe(true);

    const reportWrite = mockWriteFile.mock.calls.find((c) => String(c[0]).endsWith('qa_report.md'));
    expect(reportWrite?.[1]).toBe(`${agentReport}\n# QA Report`);
  });

  it('blocks approval on design-check findings in block mode, and only reports them in warn mode', async () => {
    const finding = { rule: 'off-palette-color' as const, file: 'src/A.tsx', line: 3, match: '#7c3aed', message: 'not in palette' };
    const run = async (mode: 'block' | 'warn') => {
      let calls = 0;
      mockReadFile.mockReset();
      mockWriteFile.mockReset().mockResolvedValue(undefined);
      const runSession = vi.fn().mockImplementation(async () => {
        calls++;
        return makeSessionResult('completed');
      });
      mockReadFile.mockImplementation((path: string) => {
        if (path.endsWith('implementation_plan.json')) return Promise.resolve(calls === 0 ? completedPlan() : completedPlan('approved'));
        return Promise.reject(new Error('ENOENT'));
      });
      const outcome = await new QALoop(
        makeConfig({ runSession, maxIterations: 1, runDesignCheck: async () => ({ findings: [finding], mode }) }),
      ).run();
      const report = mockWriteFile.mock.calls.find((c) => String(c[0]).endsWith('design_check.md'));
      return { outcome, report: String(report?.[1] ?? '') };
    };

    const blocked = await run('block');
    expect(blocked.outcome.approved).toBe(false);
    expect(blocked.report).toContain('| src/A.tsx | 3 | off-palette-color | `#7c3aed` |');

    const warned = await run('warn');
    expect(warned.outcome.approved).toBe(true);
    expect(warned.report).toContain('report only');
  });

  it('records why QA ended without approval: reviewer approved, the design check blocked', async () => {
    const { mkdtempSync, readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { tmpdir } = await import('node:os');
    const specDir = mkdtempSync(path.join(tmpdir(), 'vtl-qaout-'));
    const finding = { rule: 'gradient' as const, file: 'src/Grid.tsx', line: 7, match: 'repeating-linear-gradient(', message: 'Gradients are not part of the design system' };
    let calls = 0;
    mockReadFile.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    const runSession = vi.fn().mockImplementation(async () => {
      calls++;
      return makeSessionResult('completed');
    });
    mockReadFile.mockImplementation((p: string) => {
      if (p.endsWith('implementation_plan.json')) return Promise.resolve(calls === 0 ? completedPlan() : completedPlan('approved'));
      return Promise.reject(new Error('ENOENT'));
    });
    const outcome = await new QALoop(
      makeConfig({ specDir, runSession, maxIterations: 1, runDesignCheck: async () => ({ findings: [finding], mode: 'block' }) }),
    ).run();

    expect(outcome.approved).toBe(false);
    const recorded = JSON.parse(readFileSync(path.join(specDir, 'qa_outcome.json'), 'utf-8'));
    expect(recorded).toMatchObject({ approved: false, reason: 'max_iterations', reviewerApproved: true });
    expect(recorded.blocking).toEqual([
      { source: 'design', title: 'Gradients are not part of the design system', location: 'src/Grid.tsx:7', match: 'repeating-linear-gradient(' },
    ]);
  });

  it('groups design findings into one issue per file', () => {
    const issues = designIssues([
      { rule: 'radius', file: 'a.tsx', line: 1, match: 'rounded-xl', message: 'sharp corners' },
      { rule: 'shadow', file: 'a.tsx', line: 2, match: 'shadow-lg', message: 'no shadows' },
      { rule: 'gradient', file: 'b.css', line: 9, match: 'linear-gradient(', message: 'no gradients' },
    ]);
    expect(issues.map((i) => i.title)).toEqual(['Design system: 2 violations in a.tsx', 'Design system: 1 violation in b.css']);
    expect(issues[0].description).toBe('line 1: rounded-xl — sharp corners\nline 2: shadow-lg — no shadows');
  });

  // -------------------------------------------------------------------------
  // Rejected then approved on retry
  // -------------------------------------------------------------------------

  it('runs fixer then approves on second iteration', async () => {
    // Track how many times runSession has been called so we know which "phase" we're in
    let sessionCallCount = 0;
    let planReadCount = 0;

    const runSession = vi.fn().mockImplementation(async () => {
      sessionCallCount++;
      return makeSessionResult('completed');
    });

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        planReadCount++;
        if (planReadCount === 1) return Promise.resolve(completedPlan()); // isBuildComplete
        // Reviewer on iteration 1 ran when sessionCallCount >= 1
        // Serve rejected until fixer has run (sessionCallCount >= 2), then approved
        if (sessionCallCount < 2) {
          return Promise.resolve(completedPlan('rejected'));
        }
        return Promise.resolve(completedPlan('approved'));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ runSession, maxIterations: 5 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(true);
    // At minimum: reviewer (iter 1) + fixer + reviewer (iter 2) = 3
    expect(sessionCallCount).toBeGreaterThanOrEqual(3);
    const calls = runSession.mock.calls as Array<[QASessionRunConfig]>;
    const agentTypes = calls.map((c) => c[0].agentType);
    expect(agentTypes).toContain('qa_reviewer');
    expect(agentTypes).toContain('qa_fixer');
  });

  // -------------------------------------------------------------------------
  // Max iterations reached
  // -------------------------------------------------------------------------

  it('returns max_iterations when approval is never reached', async () => {
    // Always return "rejected" status with a unique issue each time
    // so recurring_issues threshold is never reached within maxIterations=2
    let planReadCount = 0;

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        planReadCount++;
        if (planReadCount === 1) return Promise.resolve(completedPlan()); // build complete check

        // Return distinct issues each time to avoid recurring_issues escalation
        const plan = JSON.stringify({
          phases: [{ subtasks: [{ status: 'completed' }] }],
          qa_signoff: {
            status: 'rejected',
            issues_found: [{ title: `Unique issue ${planReadCount}`, type: 'warning' }],
          },
        });
        return Promise.resolve(plan);
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ maxIterations: 2 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('max_iterations');
  });

  // -------------------------------------------------------------------------
  // Consecutive error escalation
  // -------------------------------------------------------------------------

  it('escalates after MAX_CONSECUTIVE_ERRORS (3) consecutive unknown status responses', async () => {
    let planReadCount = 0;

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        planReadCount++;
        if (planReadCount === 1) return Promise.resolve(completedPlan()); // build complete
        // Return a plan with no qa_signoff — "unknown" status
        const planWithNoSignoff = JSON.stringify({
          phases: [{ subtasks: [{ status: 'completed' }] }],
        });
        return Promise.resolve(planWithNoSignoff);
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ maxIterations: 10 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('consecutive_errors');
  });

  // -------------------------------------------------------------------------
  // Recurring issue detection
  // -------------------------------------------------------------------------

  it('escalates when the same issue recurs 3 or more times', async () => {
    const recurringIssue = { title: 'Null pointer exception', type: 'critical' as const };
    const rejectedPlan = JSON.stringify({
      phases: [{ subtasks: [{ status: 'completed' }] }],
      qa_signoff: { status: 'rejected', issues_found: [recurringIssue] },
    });

    let planReadCount = 0;

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        planReadCount++;
        if (planReadCount === 1) return Promise.resolve(completedPlan()); // build complete
        return Promise.resolve(rejectedPlan);
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ maxIterations: 10 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('recurring_issues');
  });

  // -------------------------------------------------------------------------
  // Cancellation via AbortSignal
  // -------------------------------------------------------------------------

  it('returns cancelled outcome when aborted before first iteration runs', async () => {
    const controller = new AbortController();

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) return Promise.resolve(completedPlan());
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ abortSignal: controller.signal, maxIterations: 5 });
    const loop = new QALoop(config);

    // Abort after construction so the event listener fires
    controller.abort();

    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('cancelled');
  });

  // -------------------------------------------------------------------------
  // Fixer error handling
  // -------------------------------------------------------------------------

  it('returns error outcome when fixer session fails', async () => {
    let planReadCount = 0;

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        planReadCount++;
        if (planReadCount === 1) return Promise.resolve(completedPlan());
        return Promise.resolve(completedPlan('rejected'));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn()
      .mockResolvedValueOnce(makeSessionResult('completed')) // reviewer iteration 1
      .mockResolvedValueOnce(makeSessionResult('error'));     // fixer fails

    const config = makeConfig({ runSession, maxIterations: 5 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('error');
  });

  // -------------------------------------------------------------------------
  // Reviewer cancelled mid-loop
  // -------------------------------------------------------------------------

  it('returns cancelled when reviewer session is cancelled', async () => {
    let planReadCount = 0;

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        planReadCount++;
        if (planReadCount === 1) return Promise.resolve(completedPlan());
        return Promise.resolve(completedPlan());
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockResolvedValueOnce(makeSessionResult('cancelled'));

    const config = makeConfig({ runSession, maxIterations: 5 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('cancelled');
  });

  // -------------------------------------------------------------------------
  // Human feedback processing
  // -------------------------------------------------------------------------

  it('processes QA_FIX_REQUEST.md before running the review loop', async () => {
    // QA_FIX_REQUEST.md exists
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('QA_FIX_REQUEST.md')) return Promise.resolve('Fix this please');
      if (path.endsWith('implementation_plan.json')) return Promise.resolve(completedPlan('approved'));
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const config = makeConfig({ runSession, maxIterations: 5 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    // Fixer should have been invoked for human feedback
    const calls = runSession.mock.calls as Array<[QASessionRunConfig]>;
    expect(calls.some((c) => c[0].agentType === 'qa_fixer')).toBe(true);
    // Fix request file should be deleted
    expect(mockUnlink).toHaveBeenCalledWith(path.join(SPEC_DIR, 'QA_FIX_REQUEST.md'));
    // Overall outcome should still reflect the QA result
    expect(outcome.approved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  it('emits qa-complete event with the final outcome', async () => {
    let planReadCount = 0;
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        planReadCount++;
        if (planReadCount === 1) return Promise.resolve(completedPlan());
        return Promise.resolve(completedPlan('approved'));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig();
    const loop = new QALoop(config);

    const completedEvents: unknown[] = [];
    loop.on('qa-complete', (outcome) => completedEvents.push(outcome));

    await loop.run();

    expect(completedEvents).toHaveLength(1);
    expect((completedEvents[0] as { approved: boolean }).approved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Security gates
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Recurrence counts rounds, across runs
  // -------------------------------------------------------------------------

  describe('recurring issues', () => {
    /** The reviewer rejects with these issues every time; the plan may already hold earlier rounds. */
    function rejecting(issues: Array<Record<string, unknown>>, history: unknown[] = []) {
      const plan = JSON.stringify({
        phases: [{ subtasks: [{ status: 'completed' }] }],
        qa_iteration_history: history,
        qa_signoff: { status: 'rejected', issues_found: issues },
      });
      const fresh = JSON.stringify({ phases: [{ subtasks: [{ status: 'completed' }] }], qa_iteration_history: history });
      let reviewed = false;
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('implementation_plan.json')) return Promise.resolve(reviewed ? plan : fresh);
        return Promise.reject(new Error('ENOENT'));
      });
      return vi.fn().mockImplementation(async () => {
        reviewed = true;
        return makeSessionResult('completed');
      });
    }

    const agents = (run: ReturnType<typeof vi.fn>) => (run.mock.calls as Array<[QASessionRunConfig]>).map((c) => c[0].agentType);

    it('gives the fixer two tries: an issue escalates on its third round, not its second', async () => {
      const runSession = rejecting([{ title: 'Broken login', location: 'a.ts:1' }]);
      const outcome = await new QALoop(makeConfig({ runSession })).run();
      expect(agents(runSession)).toEqual(['qa_reviewer', 'qa_fixer', 'qa_reviewer', 'qa_fixer', 'qa_reviewer']);
      expect(outcome.reason).toBe('recurring_issues');
    });

    it('does not count identical titles within one round as recurring', async () => {
      const same = Array.from({ length: 7 }, () => ({ title: 'Secret detected', location: 'x.json:1' }));
      const runSession = rejecting(same);
      await new QALoop(makeConfig({ runSession, maxIterations: 1 })).run();
      expect(mockWriteFile.mock.calls.some((c) => String(c[0]).endsWith('QA_ESCALATION.md'))).toBe(false);
    });

    it('treats a moved line and a changed count as the same issue', async () => {
      const history = [1, 2].map((n) => ({
        iteration: n, status: 'rejected', durationMs: 1, timestamp: 't',
        issues: [{ title: `Design system: ${n} violations in a.css`, location: `a.css:${n}` }],
      }));
      const runSession = rejecting([{ title: 'Design system: 3 violations in a.css', location: 'a.css:9' }], history);
      const outcome = await new QALoop(makeConfig({ runSession })).run();
      expect(agents(runSession)).toEqual(['qa_reviewer']);
      expect(outcome.reason).toBe('recurring_issues');
    });

    it('remembers earlier runs and ignores hand-written history entries', async () => {
      const round = { iteration: 1, status: 'rejected', durationMs: 1, timestamp: 't', issues: [{ title: 'Broken login', location: 'a.ts:1' }] };
      const runSession = rejecting([{ title: 'Broken login', location: 'a.ts:1' }], [round, { status: 'fixes_applied' }, round]);
      const outcome = await new QALoop(makeConfig({ runSession })).run();
      expect(agents(runSession)).toEqual(['qa_reviewer']);
      expect(outcome.reason).toBe('recurring_issues');
    });

    it('does not fail on an issue without a title', async () => {
      const runSession = rejecting([{ description: 'something' }]);
      const outcome = await new QALoop(makeConfig({ runSession, maxIterations: 1 })).run();
      expect(outcome.reason).toBe('max_iterations');
    });
  });

  it('turns gate findings into one issue per leaking file', () => {
    const leak = (line: number, file = 'a.json') => ({ gate: 'gitleaks' as const, key: `gitleaks:r:${file}:${line}`, title: 'Secret detected', file, line });
    const osv = { gate: 'osv-scanner' as const, key: 'osv:glob@1:GHSA', title: 'Vulnerable dependency: glob', file: 'pnpm-lock.yaml' };
    const issues = gateIssues([leak(1), leak(2), leak(3, 'b.json'), osv]);
    expect(issues.map((i) => i.title)).toEqual(['Secrets: 2 findings in a.json', 'Secrets: 1 finding in b.json', 'Vulnerable dependency: glob']);
    expect(issues[0].location).toBe('a.json:1');
  });

  // -------------------------------------------------------------------------
  // The reviewer approves, a gate keeps blocking
  // -------------------------------------------------------------------------

  describe('reviewer approved but a check keeps blocking', () => {
    const gradient = (line: number) => ({ rule: 'gradient' as const, file: 'a.css', line, match: 'repeating-linear-gradient(', message: 'No gradients' });

    /** The plan as a file: what the loop writes is what it reads next. Each reviewer run signs with `verdict`. */
    function approvingReviewer(history: unknown[] = [], verdict: () => Record<string, unknown> = () => ({ status: 'approved', issues_found: [] })) {
      const state = { plan: { phases: [{ subtasks: [{ status: 'completed' }] }], qa_iteration_history: history } as Record<string, unknown> };
      mockReadFile.mockImplementation((p: string) =>
        p.endsWith('implementation_plan.json') ? Promise.resolve(JSON.stringify(state.plan)) : Promise.reject(new Error('ENOENT')),
      );
      mockWriteFile.mockImplementation((p: string, data: string) => {
        if (p.endsWith('implementation_plan.json')) state.plan = JSON.parse(data);
        return Promise.resolve();
      });
      const runSession = vi.fn().mockImplementation(async (c: QASessionRunConfig) => {
        if (c.agentType === 'qa_reviewer') state.plan.qa_signoff = verdict();
        return makeSessionResult('completed');
      });
      return { state, runSession };
    }

    const agents = (run: ReturnType<typeof vi.fn>) => (run.mock.calls as Array<[QASessionRunConfig]>).map((c) => c[0].agentType);
    const escalated = () => mockWriteFile.mock.calls.some((c) => String(c[0]).endsWith('QA_ESCALATION.md'));

    it('stops when the same finding is back after the fixer had its round, even on another line', async () => {
      const { runSession } = approvingReviewer();
      let line = 100;
      const runDesignCheck = async () => ({ findings: [gradient(line++)], mode: 'block' as const });
      const outcome = await new QALoop(makeConfig({ runSession, runDesignCheck })).run();
      expect(agents(runSession)).toEqual(['qa_reviewer', 'qa_fixer', 'qa_reviewer']);
      expect(outcome.reason).toBe('recurring_issues');
      expect(escalated()).toBe(true);
    });

    it('remembers the finding across runs, so a new run does not start the fixer again', async () => {
      const round = { iteration: 1, status: 'rejected', durationMs: 1, timestamp: 't', issues: [], gate_keys: ['design|a.css|gradient|repeating-linear-gradient('] };
      const { runSession } = approvingReviewer([round]);
      const runDesignCheck = async () => ({ findings: [gradient(103)], mode: 'block' as const });
      await new QALoop(makeConfig({ runSession, runDesignCheck })).run();
      expect(agents(runSession)).toEqual(['qa_reviewer']);
    });

    it('gives the fixer a round for a finding it has not seen', async () => {
      const { runSession } = approvingReviewer();
      let round = 0;
      const runDesignCheck = async () => {
        round++;
        const findings = [gradient(1)];
        if (round === 2) findings.push({ rule: 'gradient' as const, file: 'b.css', line: 2, match: 'linear-gradient(', message: 'No gradients' });
        return { findings: round > 2 ? [] : findings, mode: 'block' as const };
      };
      const outcome = await new QALoop(makeConfig({ runSession, runDesignCheck })).run();
      expect(agents(runSession)).toEqual(['qa_reviewer', 'qa_fixer', 'qa_reviewer', 'qa_fixer', 'qa_reviewer']);
      expect(outcome.approved).toBe(true);
    });

    it('stops for a repeated secret on a moved line too', async () => {
      const { runSession } = approvingReviewer();
      let line = 1;
      const runGates = async () => ({
        ran: ['gitleaks'], skipped: [], baseRef: 'x',
        findings: [{ gate: 'gitleaks' as const, key: `gitleaks:rule:a.ts:${line}`, title: 'Secret detected', file: 'a.ts', line: line++ }],
      });
      await new QALoop(makeConfig({ runSession, runGates: runGates as QALoopConfig['runGates'] })).run();
      expect(agents(runSession)).toEqual(['qa_reviewer', 'qa_fixer', 'qa_reviewer']);
    });

    it('keeps fixing while the reviewer itself rejects', async () => {
      const { runSession } = approvingReviewer([], () => ({ status: 'rejected', issues_found: [{ title: `Bug ${Math.random()}` }] }));
      const runDesignCheck = async () => ({ findings: [gradient(1)], mode: 'block' as const });
      await new QALoop(makeConfig({ runSession, runDesignCheck, maxIterations: 2 })).run();
      expect(agents(runSession)).toEqual(['qa_reviewer', 'qa_fixer', 'qa_reviewer']);
      expect(escalated()).toBe(false);
    });

    it('leaves no approval in the plan once a check blocked it, so a restart cannot read it as approved', async () => {
      const { state, runSession } = approvingReviewer();
      const runDesignCheck = async () => ({ findings: [gradient(1)], mode: 'block' as const });
      await new QALoop(makeConfig({ runSession, runDesignCheck, maxIterations: 1 })).run();
      expect(state.plan.qa_signoff).toBeUndefined();
    });
  });

  it('does not approve while security gates have findings, then approves once clear', async () => {
    let sessionCallCount = 0;
    const runSession = vi.fn().mockImplementation(async () => {
      sessionCallCount++;
      return makeSessionResult('completed');
    });
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        return Promise.resolve(sessionCallCount === 0 ? completedPlan() : completedPlan('approved'));
      }
      return Promise.reject(new Error('ENOENT'));
    });
    const finding = { gate: 'gitleaks' as const, key: 'k', title: 'Secret detected: AWS key', file: 'src/a.ts', line: 3 };
    const runGates = vi
      .fn()
      .mockResolvedValueOnce({ ran: ['gitleaks'], skipped: [], findings: [finding] })
      .mockResolvedValue({ ran: ['gitleaks'], skipped: [], findings: [] });

    const config = makeConfig({ runSession, runGates });
    const outcome = await new QALoop(config).run();

    expect(outcome.approved).toBe(true);
    expect(outcome.totalIterations).toBe(2);
    // reviewer, fixer (for the gate finding), reviewer
    expect(runSession.mock.calls.map((c) => (c[0] as QASessionRunConfig).agentType)).toEqual([
      'qa_reviewer',
      'qa_fixer',
      'qa_reviewer',
    ]);
  });

  it('keeps going when the gates themselves fail', async () => {
    let sessionCallCount = 0;
    const runSession = vi.fn().mockImplementation(async () => {
      sessionCallCount++;
      return makeSessionResult('completed');
    });
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        return Promise.resolve(sessionCallCount === 0 ? completedPlan() : completedPlan('approved'));
      }
      return Promise.reject(new Error('ENOENT'));
    });
    const config = makeConfig({ runSession, runGates: vi.fn().mockRejectedValue(new Error('spawn failed')) });
    expect((await new QALoop(config).run()).approved).toBe(true);
  });
});
