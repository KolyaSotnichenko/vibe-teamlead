/**
 * update_qa_status Tool
 * =====================
 *
 * Updates the QA sign-off status in implementation_plan.json.
 * See apps/desktop/src/main/ai/tools/app-tools/update-qa-status.ts for the TypeScript implementation.
 *
 * Tool name: mcp__vibe-teamlead__update_qa_status
 *
 * IMPORTANT: Do NOT write plan["status"] or plan["planStatus"] here.
 * The frontend XState task state machine owns status transitions.
 * Writing status here races with XState and can clobber reviewReason.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod/v3';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import { safeParseJson } from '../../../utils/json-repair';
import { QASignoffSchema } from '../../schema/qa-signoff';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  status: z
    .enum(['pending', 'in_review', 'approved', 'rejected', 'fixes_applied'])
    .describe('QA status to set'),
  issues: z
    .string()
    .optional()
    .describe('JSON array of issues found, or plain text description. Use [] for no issues.'),
  tests_passed: z
    .string()
    .optional()
    .describe('JSON object of test results (e.g., {"unit": "pass", "e2e": "pass"})'),
});

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface QAIssue {
  description?: string;
  [key: string]: unknown;
}

interface QASignoff {
  status: string;
  qa_session: number;
  issues_found: QAIssue[];
  tests_passed: Record<string, unknown>;
  timestamp: string;
  ready_for_qa_revalidation: boolean;
}

interface ImplementationPlan {
  qa_signoff?: QASignoff;
  last_updated?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const updateQaStatusTool = Tool.define({
  metadata: {
    name: 'mcp__vibe-teamlead__update_qa_status',
    description:
      'Update the QA sign-off status in implementation_plan.json. Use this after completing a QA review to record the outcome.',
    permission: ToolPermission.Auto,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: (input, context) => {
    const { status, issues: issuesStr, tests_passed: testsStr } = input;
    if (status === 'approved' && context.agentType === 'qa_fixer') {
      return "Error: only the QA reviewer can approve. Use status 'fixes_applied'; the reviewer checks your fixes next.";
    }
    const planFile = path.join(context.specDir, 'implementation_plan.json');

    if (!fs.existsSync(planFile)) {
      return 'Error: implementation_plan.json not found';
    }

    // Parse issues
    let issues: QAIssue[] = [];
    if (issuesStr) {
      const parsed = safeParseJson<QAIssue[]>(issuesStr);
      if (parsed !== null && Array.isArray(parsed)) {
        issues = parsed;
      } else {
        issues = [{ description: issuesStr }];
      }
    }

    // Parse tests_passed
    let testsPassed: Record<string, unknown> = {};
    if (testsStr) {
      const parsed = safeParseJson<Record<string, unknown>>(testsStr);
      if (parsed !== null) {
        testsPassed = parsed;
      }
    }

    const plan = safeParseJson<ImplementationPlan>(fs.readFileSync(planFile, 'utf-8'));
    if (!plan) {
      return 'Error: implementation_plan.json contains unrepairable JSON';
    }

    // Increment qa_session on new review or rejection
    const current = plan.qa_signoff;
    // Agents have written other things here by hand; `++` on a string gives NaN, which JSON turns into null
    let qaSession = typeof current?.qa_session === 'number' && Number.isFinite(current.qa_session) ? current.qa_session : 0;
    if (status === 'in_review' || status === 'rejected') {
      qaSession++;
    }

    const signoff: QASignoff = {
      status,
      qa_session: qaSession,
      issues_found: issues,
      tests_passed: testsPassed,
      timestamp: new Date().toISOString(),
      ready_for_qa_revalidation: status === 'fixes_applied',
    };
    // The QA loop reads the plan with this schema: tell the agent now rather than lose the verdict later
    const checked = QASignoffSchema.safeParse(signoff);
    if (!checked.success) {
      return `Error: invalid QA status, nothing recorded: ${checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. Pass issues as a JSON array of objects with title, location and description.`;
    }
    plan.qa_signoff = signoff;
    plan.last_updated = new Date().toISOString();

    try {
      const tmp = `${planFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(plan, null, 2), 'utf-8');
      fs.renameSync(tmp, planFile);
      return `Updated QA status to '${status}' (session ${qaSession})`;
    } catch (e) {
      return `Error writing implementation_plan.json: ${e}`;
    }
  },
});
