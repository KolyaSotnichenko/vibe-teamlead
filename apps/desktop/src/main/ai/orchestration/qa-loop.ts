/**
 * QA Validation Loop
 * ==================
 *
 * See apps/desktop/src/main/ai/orchestration/qa-loop.ts for the TypeScript implementation.
 *
 * Coordinates the QA review/fix iteration cycle:
 *   1. QA Reviewer agent validates the build
 *   2. If rejected → QA Fixer agent applies fixes
 *   3. Loop back to reviewer
 *   4. Repeat until approved, max iterations, or escalation
 *
 * Enhanced with:
 * - Recurring issue detection (escalate after threshold)
 * - Consecutive error tracking (escalate after MAX_CONSECUTIVE_ERRORS)
 * - Human feedback processing (QA_FIX_REQUEST.md)
 */

import { writeFileSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'events';

import {
  DEFAULT_QA_ITERATIONS,
  generateEscalationReport,
  generateManualTestPlan,
  generateQAReport,
  mergeQAReport,
} from './qa-reports';

import type { AgentType } from '../config/agent-configs';
import type { Phase } from '../config/types';
import { QASignoffSchema, validateStructuredOutput } from '../schema';
import { safeParseJson } from '../../utils/json-repair';
import type { SessionResult } from '../session/types';
import type { GateFinding, GateReport } from '../security/gates';
import type { DesignFinding, DesignQaMode, QaOutcomeInfo } from '../../../shared/types';

// =============================================================================
// Constants
// =============================================================================

/** Maximum QA review/fix iterations before escalating to human */
export { DEFAULT_QA_ITERATIONS };

/** Stop after this many consecutive errors without progress */
const MAX_CONSECUTIVE_ERRORS = 3;

/** Rounds an issue must appear in before escalation: the fixer gets two tries at it */
const RECURRING_ISSUE_THRESHOLD = 3;

// =============================================================================
// Types
// =============================================================================

/** QA signoff status from implementation_plan.json */
type QAStatus = 'approved' | 'rejected' | 'fixes_applied' | 'unknown';

/** A single QA issue found during review */
export interface QAIssue {
  type?: 'critical' | 'warning';
  /** Reviewers may leave it out: the schema only requires a description */
  title?: string;
  description?: string;
  location?: string;
  fix_required?: string;
}

/** Record of a single QA iteration */
export interface QAIterationRecord {
  iteration: number;
  status: 'approved' | 'rejected' | 'error';
  issues: QAIssue[];
  durationMs: number;
  timestamp: string;
  /** What the gates found this round, independent of line numbers */
  gate_keys?: string[];
}

/** Configuration for the QA loop */
export interface QALoopConfig {
  /** Spec directory path */
  specDir: string;
  /** Project root directory */
  projectDir: string;
  /** CLI model override */
  cliModel?: string;
  /** CLI thinking level override */
  cliThinking?: string;
  /** Maximum iterations override (default: DEFAULT_QA_ITERATIONS) */
  maxIterations?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Callback to generate system prompt */
  generatePrompt: (agentType: AgentType, context: QAPromptContext) => Promise<string>;
  /** Callback to run an agent session */
  runSession: (config: QASessionRunConfig) => Promise<SessionResult>;
  /**
   * Security gates (gitleaks, OSV-Scanner) run before every review. Findings
   * are hard gates: QA cannot approve while any remain.
   */
  runGates?: () => Promise<GateReport>;
  /**
   * Static design check on the lines the task added to UI files. In 'block'
   * mode its findings are QA issues like gate findings; in 'warn' mode they are
   * only reported (design_check.md in the spec dir).
   */
  runDesignCheck?: () => Promise<{ findings: DesignFinding[]; mode: DesignQaMode }>;
}

/** One QA issue per file with design-check findings. Pure — tested directly. */
export function designIssues(findings: DesignFinding[]): QAIssue[] {
  const byFile = new Map<string, DesignFinding[]>();
  for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  return [...byFile.entries()].map(([file, list]) => ({
    type: 'critical' as const,
    title: `Design system: ${list.length} violation${list.length === 1 ? '' : 's'} in ${file}`,
    description: list.slice(0, 8).map((f) => `line ${f.line}: ${f.match} — ${f.message}`).join('\n') + (list.length > 8 ? `\n…and ${list.length - 8} more` : ''),
    location: `${file}:${list[0].line}`,
    fix_required: 'Use the design system tokens (colours, radius, shadows) and components instead; see design_check.md and the Design system section of your instructions.',
  }));
}

/**
 * Gate findings as QA issues: one per file for secrets, so the fixer gets a short
 * list and one leaking file is one problem. Pure — tested directly.
 */
export function gateIssues(findings: GateFinding[]): QAIssue[] {
  const issues: QAIssue[] = [];
  const secrets = new Map<string, GateFinding[]>();
  for (const f of findings) {
    if (f.gate !== 'gitleaks') continue;
    const file = f.file ?? '';
    secrets.set(file, [...(secrets.get(file) ?? []), f]);
  }
  const done = new Set<string>();
  for (const f of findings) {
    if (f.gate === 'gitleaks') {
      const file = f.file ?? '';
      if (done.has(file)) continue;
      done.add(file);
      const list = secrets.get(file) ?? [];
      issues.push({
        type: 'critical',
        title: `Secrets: ${list.length} finding${list.length === 1 ? '' : 's'} in ${file || 'the working tree'}`,
        description: list.map((x) => (x.line ? `line ${x.line}: ${x.title}` : x.title)).join('\n'),
        location: f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : undefined,
        fix_required: 'Remove the secret from code and history; load it from configuration; tell the user to rotate it.',
      });
      continue;
    }
    issues.push({
      type: 'critical',
      title: f.title,
      description: f.detail,
      location: f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : undefined,
      fix_required: 'Upgrade to a fixed version or replace the dependency, then re-run the tests.',
    });
  }
  return issues;
}

/**
 * What makes two issues the same problem: the file without its line, and the
 * title without a finding count. Pure.
 */
function issueKey(issue: QAIssue): string {
  const where = (issue.location ?? '').replace(/:[\d,-]+$/, '').trim().toLowerCase();
  const what = (issue.title ?? issue.description ?? '')
    .toLowerCase()
    .replace(/\b\d+ (violation|finding)s?\b/g, '$1s')
    .trim();
  return `${where}|${what}`;
}

/** The current issues seen in RECURRING_ISSUE_THRESHOLD rounds or more; `history` includes this round. Pure. */
function findRecurring(history: QAIterationRecord[], current: QAIssue[]): QAIssue[] {
  return current.filter((issue) => {
    const key = issueKey(issue);
    return history.filter((round) => round.issues.some((i) => issueKey(i) === key)).length >= RECURRING_ISSUE_THRESHOLD;
  });
}

/** design_check.md for the reviewer, the fixer and the Workspace. Pure. */
export function formatDesignCheck(findings: DesignFinding[], mode: DesignQaMode): string {
  const lines = ['# Design check', '', `Mode: ${mode === 'block' ? 'blocking — QA cannot approve with findings' : 'report only'}`, ''];
  if (!findings.length) return [...lines, 'No findings: the added UI code uses the design system tokens.', ''].join('\n');
  lines.push('| File | Line | Rule | Found | Why |', '|---|---|---|---|---|');
  for (const f of findings) lines.push(`| ${f.file} | ${f.line} | ${f.rule} | \`${f.match.replace(/\|/g, '\\|')}\` | ${f.message} |`);
  return [...lines, ''].join('\n');
}

/** Context passed to prompt generation */
export interface QAPromptContext {
  /** Current iteration number */
  iteration: number;
  /** Max iterations allowed */
  maxIterations: number;
  /** Whether processing human feedback */
  isHumanFeedback?: boolean;
  /** Previous error context for self-correction */
  previousError?: QAErrorContext;
}

/** Error context for self-correction feedback */
interface QAErrorContext {
  errorType: string;
  errorMessage: string;
  consecutiveErrors: number;
  expectedAction: string;
}

/** Configuration passed to runSession callback */
export interface QASessionRunConfig {
  agentType: AgentType;
  phase: Phase;
  systemPrompt: string;
  specDir: string;
  projectDir: string;
  sessionNumber: number;
  abortSignal?: AbortSignal;
  cliModel?: string;
  cliThinking?: string;
}

/** Events emitted by the QA loop */
export interface QALoopEvents {
  /** QA iteration started */
  'qa-iteration-start': (iteration: number, maxIterations: number) => void;
  /** QA review completed */
  'qa-review-complete': (iteration: number, status: QAStatus, issues: QAIssue[]) => void;
  /** QA fixer started */
  'qa-fix-start': (iteration: number) => void;
  /** QA fixer completed */
  'qa-fix-complete': (iteration: number) => void;
  /** QA loop finished */
  'qa-complete': (outcome: QAOutcome) => void;
  /** Log message */
  'log': (message: string) => void;
  /** Error during QA */
  'error': (error: Error) => void;
}

/** Final QA outcome */
export interface QAOutcome {
  /** Whether QA approved the build */
  approved: boolean;
  /** Total iterations executed */
  totalIterations: number;
  /** Duration in ms */
  durationMs: number;
  /** Reason if not approved */
  reason?: 'max_iterations' | 'recurring_issues' | 'consecutive_errors' | 'cancelled' | 'error' | 'security_findings';
  /** Error message if failed */
  error?: string;
}

/** QA signoff structure from implementation_plan.json */
interface QASignoff {
  status: string;
  qa_session?: number;
  tests_passed?: Record<string, string>;
  issues_found?: QAIssue[];
}

// =============================================================================
// QALoop
// =============================================================================

/**
 * Orchestrates the QA validation loop: review → fix → re-review.
 *
 * Replaces the Python `run_qa_validation_loop()` from `qa/loop.py`.
 */
export class QALoop extends EventEmitter {
  private config: QALoopConfig;
  private sessionNumber = 0;
  private aborted = false;
  private iterationHistory: QAIterationRecord[] = [];
  private lastReviewerApproved = false;
  private lastBlocking: QaOutcomeInfo['blocking'] = [];
  private lastDesignFindings: DesignFinding[] = [];
  private lastGateKeys: string[] = [];

  constructor(config: QALoopConfig) {
    super();
    this.config = config;

    config.abortSignal?.addEventListener('abort', () => {
      this.aborted = true;
    });
  }

  /**
   * Run the full QA validation loop.
   *
   * @returns QAOutcome indicating whether the build was approved
   */
  async run(): Promise<QAOutcome> {
    const startTime = Date.now();
    const maxIterations = this.config.maxIterations ?? DEFAULT_QA_ITERATIONS;

    try {
      // Verify build is complete
      const buildComplete = await this.isBuildComplete();
      if (!buildComplete) {
        this.emitTyped('log', 'Build is not complete, cannot run QA validation');
        return this.outcome(false, 0, Date.now() - startTime, 'error', 'Build not complete');
      }

      // Check if already approved (unless human feedback pending)
      const hasHumanFeedback = await this.hasHumanFeedback();
      if (!hasHumanFeedback) {
        const currentStatus = await this.readQASignoff();
        if (currentStatus?.status === 'approved') {
          this.emitTyped('log', 'Build already approved by QA');
          return this.outcome(true, 0, Date.now() - startTime);
        }
      }

      // Process human feedback first if present
      if (hasHumanFeedback) {
        await this.processHumanFeedback();
      }

      // Rounds of earlier runs count too: a restart must not hide a recurring issue
      this.iterationHistory = await this.loadIterationHistory();

      // Main QA loop
      let consecutiveErrors = 0;
      let lastErrorContext: QAErrorContext | undefined;

      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (this.aborted) {
          return this.outcome(false, iteration - 1, Date.now() - startTime, 'cancelled');
        }

        const iterationStart = Date.now();
        this.emitTyped('qa-iteration-start', iteration, maxIterations);

        // Security gates first, so the reviewer and fixer see their findings
        this.lastGateKeys = [];
        const securityIssues = await this.runGates();
        const designBlocking = await this.runDesignCheck();
        const blockers = [...securityIssues, ...designBlocking];

        // Run QA reviewer. The previous verdict is cleared first so a reviewer that
        // fails to write one can never be read as approving.
        await this.clearQASignoff();
        this.sessionNumber++;
        const reviewPrompt = await this.config.generatePrompt('qa_reviewer', {
          iteration,
          maxIterations,
          previousError: lastErrorContext,
        });

        const reviewResult = await this.config.runSession({
          agentType: 'qa_reviewer',
          phase: 'qa',
          systemPrompt: reviewPrompt,
          specDir: this.config.specDir,
          projectDir: this.config.projectDir,
          sessionNumber: this.sessionNumber,
          abortSignal: this.config.abortSignal,
          cliModel: this.config.cliModel,
          cliThinking: this.config.cliThinking,
        });

        if (reviewResult.outcome === 'cancelled') {
          return this.outcome(false, iteration, Date.now() - startTime, 'cancelled');
        }

        // Read QA signoff from implementation_plan.json
        const signoff = await this.readQASignoff();
        let status = this.resolveQAStatus(signoff);
        let issues = signoff?.issues_found ?? [];

        this.lastReviewerApproved = status === 'approved';
        const reviewerIssues = status === 'rejected' ? issues : [];
        if (blockers.length && status !== 'unknown') {
          if (status === 'approved') {
            // Say which check blocked it: the reviewer approved
            if (securityIssues.length) this.emitTyped('log', `Security gates blocked approval: ${securityIssues.length} finding(s)`);
            if (designBlocking.length) this.emitTyped('log', `Design check blocked approval: ${designBlocking.length} finding(s) (see design_check.md)`);
          }
          status = 'rejected';
          // The approval no longer stands: left in the plan, a restart would read it as approved
          await this.clearQASignoff();
          const known = new Set(issues.map((i) => i.title));
          issues = [...issues, ...blockers.filter((i) => !known.has(i.title))];
        }
        this.lastBlocking = [
          ...securityIssues.map((i) => ({ source: 'security' as const, title: i.title ?? '', location: i.location })),
          ...this.lastDesignFindings.map((f) => ({ source: 'design' as const, title: f.message, location: `${f.file}:${f.line}`, match: f.match })),
          ...reviewerIssues.map((i) => ({ source: 'qa' as const, title: i.title ?? i.description ?? '', location: i.location })),
        ];
        const iterationDuration = Date.now() - iterationStart;

        this.emitTyped('qa-review-complete', iteration, status, issues);

        if (status === 'approved') {
          await this.recordIteration(iteration, 'approved', [], iterationDuration);
          await this.writeReports('approved');
          return this.outcome(true, iteration, Date.now() - startTime);
        }

        if (status === 'rejected') {
          consecutiveErrors = 0;
          lastErrorContext = undefined;
          const gateKeys = this.lastGateKeys;
          const seenBefore = new Set(this.iterationHistory.flatMap((r) => r.gate_keys ?? []));
          await this.recordIteration(iteration, 'rejected', issues, iterationDuration, gateKeys);

          // The reviewer is satisfied and the checks found nothing new: another fixer
          // round can't help (a false positive, say). Only the user can settle it.
          if (this.lastReviewerApproved && gateKeys.length && gateKeys.every((k) => seenBefore.has(k))) {
            this.emitTyped('log', 'The reviewer approved but the same check findings are back — handing over to you');
            await this.escalate(blockers);
            return this.outcome(false, iteration, Date.now() - startTime, 'recurring_issues');
          }

          // Check for recurring issues
          const recurring = findRecurring(this.iterationHistory, issues);
          if (recurring.length) {
            this.emitTyped('log', 'Recurring issues detected — escalating to human review');
            await this.escalate(recurring);
            return this.outcome(false, iteration, Date.now() - startTime, 'recurring_issues');
          }

          if (iteration >= maxIterations) {
            break; // Max iterations reached
          }

          // Run QA fixer
          this.emitTyped('qa-fix-start', iteration);
          this.sessionNumber++;

          const fixPrompt = await this.config.generatePrompt('qa_fixer', {
            iteration,
            maxIterations,
          });

          const fixResult = await this.config.runSession({
            agentType: 'qa_fixer',
            phase: 'qa',
            systemPrompt: fixPrompt,
            specDir: this.config.specDir,
            projectDir: this.config.projectDir,
            sessionNumber: this.sessionNumber,
            abortSignal: this.config.abortSignal,
            cliModel: this.config.cliModel,
            cliThinking: this.config.cliThinking,
          });

          if (fixResult.outcome === 'cancelled') {
            await this.writeReports('max_iterations');
            return this.outcome(false, iteration, Date.now() - startTime, 'cancelled');
          }

          if (fixResult.outcome === 'error' || fixResult.outcome === 'auth_failure') {
            this.emitTyped('log', `Fixer error: ${fixResult.error?.message ?? 'unknown'}`);
            await this.writeReports('max_iterations');
            return this.outcome(false, iteration, Date.now() - startTime, 'error', fixResult.error?.message);
          }

          this.emitTyped('qa-fix-complete', iteration);
          this.emitTyped('log', 'Fixes applied, re-running QA validation...');
          continue;
        }

        // status === 'unknown' — QA agent didn't update implementation_plan.json
        consecutiveErrors++;
        const errorMsg = 'QA agent did not update implementation_plan.json with qa_signoff';
        await this.recordIteration(iteration, 'error', [{ title: 'QA error', description: errorMsg }], iterationDuration);

        lastErrorContext = {
          errorType: 'missing_implementation_plan_update',
          errorMessage: errorMsg,
          consecutiveErrors,
          expectedAction: 'You MUST update implementation_plan.json with a qa_signoff object containing status: approved or status: rejected',
        };

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.emitTyped('log', `${MAX_CONSECUTIVE_ERRORS} consecutive errors — escalating to human`);
          await this.writeReports('max_iterations');
          return this.outcome(false, iteration, Date.now() - startTime, 'consecutive_errors');
        }

        this.emitTyped('log', `QA error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}), retrying with error feedback...`);
      }

      // Max iterations reached
      await this.writeReports('max_iterations');
      return this.outcome(false, maxIterations, Date.now() - startTime, 'max_iterations');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.outcome(false, 0, Date.now() - startTime, 'error', message);
    }
  }

  // ===========================================================================
  // Security gates
  // ===========================================================================

  /**
   * Design check: findings grouped per file (one issue each, so the fixer gets a
   * short list), written to design_check.md. Blocking only in 'block' mode. Never throws.
   */
  private async runDesignCheck(): Promise<QAIssue[]> {
    if (!this.config.runDesignCheck) return [];
    try {
      const { findings, mode } = await this.config.runDesignCheck();
      if (mode === 'off') return [];
      await writeFile(join(this.config.specDir, 'design_check.md'), formatDesignCheck(findings, mode), 'utf-8').catch(() => {});
      this.emitTyped('log', `Design check: ${findings.length ? `${findings.length} finding(s)${mode === 'warn' ? ' (warn only)' : ''}` : 'clear'}`);
      if (mode !== 'block') {
        this.lastDesignFindings = [];
        return [];
      }
      this.lastDesignFindings = findings;
      this.lastGateKeys.push(...findings.map((f) => `design|${f.file}|${f.rule}|${f.match}`));
      return designIssues(findings);
    } catch (error) {
      this.emitTyped('log', `Design check failed to run: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** Run the gates; returns their findings as blocking QA issues. Never throws. */
  private async runGates(): Promise<QAIssue[]> {
    if (!this.config.runGates) return [];
    try {
      const report = await this.config.runGates();
      for (const skipped of report.skipped) this.emitTyped('log', `Security gate skipped (${skipped.gate}): ${skipped.reason}`);
      if (report.ran.length) {
        this.emitTyped('log', `Security gates (${report.ran.join(', ')}): ${report.findings.length ? `${report.findings.length} finding(s)` : 'clear'}`);
      }
      // The last part of a gitleaks key is the line, which moves with any edit
      this.lastGateKeys.push(...report.findings.map((f) => f.key.replace(/:\d+$/, '')));
      return gateIssues(report.findings);
    } catch (error) {
      this.emitTyped('log', `Security gates failed to run: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ===========================================================================
  // Status Reading
  // ===========================================================================

  /**
   * Read QA signoff from implementation_plan.json.
   */
  private async readQASignoff(): Promise<QASignoff | null> {
    try {
      const planPath = join(this.config.specDir, 'implementation_plan.json');
      const raw = await readFile(planPath, 'utf-8');
      const plan = safeParseJson<{ qa_signoff?: unknown }>(raw);
      if (!plan) return null;
      const qa_signoff = plan.qa_signoff;
      if (!qa_signoff) return null;
      const result = validateStructuredOutput(qa_signoff, QASignoffSchema);
      return result.valid && result.data ? (result.data as QASignoff) : null;
    } catch {
      return null;
    }
  }

  /** Remove qa_signoff from implementation_plan.json (no-op when absent). */
  private async clearQASignoff(): Promise<void> {
    const planPath = join(this.config.specDir, 'implementation_plan.json');
    try {
      const plan = safeParseJson<Record<string, unknown>>(await readFile(planPath, 'utf-8'));
      if (!plan || !('qa_signoff' in plan)) return;
      delete plan.qa_signoff;
      await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
    } catch {
      // Unreadable plan: the reviewer's own write decides.
    }
  }

  /**
   * Resolve QA status from signoff data.
   */
  private resolveQAStatus(signoff: QASignoff | null): QAStatus {
    if (!signoff) return 'unknown';
    const status = signoff.status?.toLowerCase();
    if (status === 'approved' || status === 'passed') return 'approved';
    if (status === 'rejected' || status === 'failed' || status === 'issues') return 'rejected';
    if (status === 'fixes_applied') return 'fixes_applied';
    return 'unknown';
  }

  /**
   * Check if all subtasks in the build are completed.
   */
  private async isBuildComplete(): Promise<boolean> {
    try {
      const planPath = join(this.config.specDir, 'implementation_plan.json');
      const raw = await readFile(planPath, 'utf-8');
      const plan = safeParseJson<{ phases?: Array<{ subtasks: Array<{ status: string }> }> }>(raw);

      if (!plan || !plan.phases) return false;

      for (const phase of plan.phases) {
        for (const subtask of phase.subtasks) {
          if (subtask.status !== 'completed') return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // Human Feedback
  // ===========================================================================

  /**
   * Check if human feedback file exists.
   */
  private async hasHumanFeedback(): Promise<boolean> {
    try {
      await readFile(join(this.config.specDir, 'QA_FIX_REQUEST.md'), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Process human feedback by running the fixer agent first.
   */
  private async processHumanFeedback(): Promise<void> {
    this.emitTyped('log', 'Human feedback detected — running QA Fixer first');
    this.emitTyped('qa-fix-start', 0);
    this.sessionNumber++;

    const fixPrompt = await this.config.generatePrompt('qa_fixer', {
      iteration: 0,
      maxIterations: this.config.maxIterations ?? DEFAULT_QA_ITERATIONS,
      isHumanFeedback: true,
    });

    const result = await this.config.runSession({
      agentType: 'qa_fixer',
      phase: 'qa',
      systemPrompt: fixPrompt,
      specDir: this.config.specDir,
      projectDir: this.config.projectDir,
      sessionNumber: this.sessionNumber,
      abortSignal: this.config.abortSignal,
      cliModel: this.config.cliModel,
      cliThinking: this.config.cliThinking,
    });

    // Remove fix request file unless transient error
    if (result.outcome !== 'rate_limited' && result.outcome !== 'auth_failure') {
      try {
        await unlink(join(this.config.specDir, 'QA_FIX_REQUEST.md'));
      } catch {
        // Ignore removal failure
      }
    }

    this.emitTyped('qa-fix-complete', 0);
  }

  // ===========================================================================
  // Iteration History
  // ===========================================================================

  /** Rounds recorded by earlier runs; entries an agent wrote into the plan by hand are skipped. */
  private async loadIterationHistory(): Promise<QAIterationRecord[]> {
    try {
      const raw = await readFile(join(this.config.specDir, 'implementation_plan.json'), 'utf-8');
      const plan = safeParseJson<{ qa_iteration_history?: QAIterationRecord[] }>(raw);
      return (plan?.qa_iteration_history ?? []).filter(
        (r) => Array.isArray(r.issues) && ['approved', 'rejected', 'error'].includes(r.status),
      );
    } catch {
      return [];
    }
  }

  /**
   * Record an iteration in the history and persist it to implementation_plan.json.
   */
  private async recordIteration(
    iteration: number,
    status: 'approved' | 'rejected' | 'error',
    issues: QAIssue[],
    durationMs: number,
    gateKeys?: string[],
  ): Promise<void> {
    const record: QAIterationRecord = {
      iteration,
      status,
      issues,
      durationMs,
      timestamp: new Date().toISOString(),
      ...(gateKeys?.length ? { gate_keys: gateKeys } : {}),
    };

    this.iterationHistory.push(record);

    // Persist to implementation_plan.json
    try {
      const planPath = join(this.config.specDir, 'implementation_plan.json');
      const raw = await readFile(planPath, 'utf-8');
      const plan = safeParseJson<{
        qa_iteration_history?: QAIterationRecord[];
        qa_stats?: Record<string, unknown>;
      }>(raw);

      if (!plan) return;

      if (!plan.qa_iteration_history) {
        plan.qa_iteration_history = [];
      }
      plan.qa_iteration_history.push(record);

      // Update summary stats
      plan.qa_stats = {
        total_iterations: plan.qa_iteration_history.length,
        last_iteration: iteration,
        last_status: status,
      };

      await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
    } catch {
      // Non-fatal — iteration is still tracked in memory
    }
  }

  /** QA_ESCALATION.md and the final reports. Never throws. */
  private async escalate(issues: QAIssue[]): Promise<void> {
    try {
      await writeFile(join(this.config.specDir, 'QA_ESCALATION.md'), generateEscalationReport(this.iterationHistory, issues), 'utf-8');
    } catch {
      // Non-fatal
    }
    await this.writeReports('escalated');
  }

  /**
   * Write all QA reports to disk at the end of the loop.
   */
  private async writeReports(finalStatus: 'approved' | 'escalated' | 'max_iterations'): Promise<void> {
    const specDir = this.config.specDir;
    const projectDir = this.config.projectDir;

    try {
      // Keep the reviewer's report (its AC coverage table feeds the Workspace) and add the summary below
      const reportPath = join(specDir, 'qa_report.md');
      const agentReport = await readFile(reportPath, 'utf-8').catch(() => null);
      const qaReport = mergeQAReport(agentReport, generateQAReport(this.iterationHistory, finalStatus));
      await writeFile(reportPath, qaReport, 'utf-8');
    } catch {
      // Non-fatal
    }

    try {
      const manualTestPlan = await generateManualTestPlan(specDir, projectDir);
      await writeFile(join(specDir, 'MANUAL_TEST_PLAN.md'), manualTestPlan, 'utf-8');
    } catch {
      // Non-fatal
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private outcome(
    approved: boolean,
    totalIterations: number,
    durationMs: number,
    reason?: QAOutcome['reason'],
    error?: string,
  ): QAOutcome {
    const outcome: QAOutcome = {
      approved,
      totalIterations,
      durationMs,
      reason: approved ? undefined : reason,
      error,
    };

    // What blocked it, for the task window ("Has Errors" alone says nothing)
    if (reason !== 'cancelled') {
      const info: QaOutcomeInfo = {
        approved,
        reason: approved ? undefined : reason,
        iterations: totalIterations,
        reviewerApproved: approved || this.lastReviewerApproved,
        blocking: approved ? [] : this.lastBlocking,
        ...(error ? { error } : {}),
        at: new Date().toISOString(),
      };
      try {
        writeFileSync(join(this.config.specDir, 'qa_outcome.json'), JSON.stringify(info, null, 2), 'utf-8');
      } catch {
        // informational
      }
    }

    this.emitTyped('qa-complete', outcome);
    return outcome;
  }

  /**
   * Typed event emitter helper.
   */
  private emitTyped<K extends keyof QALoopEvents>(
    event: K,
    ...args: Parameters<QALoopEvents[K]>
  ): void {
    this.emit(event, ...args);
  }
}
