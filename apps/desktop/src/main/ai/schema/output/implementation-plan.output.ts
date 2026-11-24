/**
 * Clean Implementation Plan Output Schema
 * ========================================
 *
 * The planner's structured output (Claude Code --json-schema). When a
 * session returns it, the orchestrators save it over implementation_plan.json,
 * so every field a later stage reads has to be here: what the schema leaves
 * out is lost. `depends_on`, `service`, `patterns_from` and `verification`
 * are optional so a model that omits them still produces a valid plan.
 *
 * For file-based validation with LLM field coercion, use
 * ImplementationPlanSchema from '../implementation-plan' instead.
 */

import { z } from 'zod';

const SubtaskOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked', 'failed']),
  files_to_create: z.array(z.string()),
  files_to_modify: z.array(z.string()),
  /** The one service the subtask touches (coder kickoff) */
  service: z.string().optional(),
  /** Existing files whose patterns the coder follows (coder kickoff, code lookup) */
  patterns_from: z.array(z.string()).optional(),
  /** The design files the subtask builds to, the library's included (coder kickoff, QA's frames) */
  design_files: z.array(z.string()).optional(),
  /** How the coder proves the subtask; same shape as the plan file's schema keeps */
  verification: z.object({
    type: z.string(),
    run: z.string().optional(),
    scenario: z.string().optional(),
  }).optional(),
});

const PhaseOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Ids of the phases that must be finished first (coder kickoff, plan view) */
  depends_on: z.array(z.string()).optional(),
  subtasks: z.array(SubtaskOutputSchema),
});

export const ImplementationPlanOutputSchema = z.object({
  feature: z.string(),
  workflow_type: z.string(),
  phases: z.array(PhaseOutputSchema).min(1),
});

export type ImplementationPlanOutput = z.infer<typeof ImplementationPlanOutputSchema>;
export type PhaseOutput = z.infer<typeof PhaseOutputSchema>;
export type SubtaskOutput = z.infer<typeof SubtaskOutputSchema>;
