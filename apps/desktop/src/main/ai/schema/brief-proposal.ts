/**
 * Structured output of the brief analyst (Claude Code json_schema output).
 * Plain objects and enums only, so the JSON Schema the SDK enforces matches
 * exactly what is validated here.
 */

import { z } from 'zod';

export const BriefTaskSchema = z.object({
  key: z.string().describe('T1, T2, … in build order'),
  title: z.string().describe('Short imperative title'),
  description: z.string().describe('Self-contained description for the team building this task (markdown)'),
  epic: z.string().describe('Epic key, e.g. E1'),
  acceptanceCriteria: z.array(z.string()).describe('Given/When/Then, 2–6 items'),
  dependsOn: z.array(z.string()).describe('Keys of tasks that must be merged first'),
  complexity: z.enum(['trivial', 'small', 'medium', 'large', 'complex']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  category: z.enum([
    'feature',
    'bug_fix',
    'refactoring',
    'documentation',
    'security',
    'performance',
    'ui_ux',
    'infrastructure',
    'testing',
  ]),
  sourceSection: z.string().describe('Heading or short phrase of the brief this comes from'),
  covers: z.array(z.string()).describe("The brief's requirement ids this task builds in full (FR-12, NFR-03…), exactly as the brief writes them; empty when the brief has no ids"),
});

export const BriefProposalSchema = z.object({
  title: z.string().describe('Name of what the brief describes'),
  summary: z.string().describe('2–4 sentences: what will be built'),
  epics: z.array(z.object({ key: z.string(), title: z.string(), summary: z.string() })),
  tasks: z.array(BriefTaskSchema),
  assumptions: z.array(z.string()),
  openQuestions: z.array(
    z.object({
      question: z.string().describe('One decision only the user can make, phrased to stand on its own'),
      tasks: z.array(z.string()).describe('Keys of the tasks whose spec depends on the answer'),
    }),
  ),
  remaining: z
    .array(z.string())
    .describe("What of the brief no task proposed so far covers: one line each, with the brief's id or heading. Empty only when every requirement of the brief has a task. The app asks for the next part while this is not empty"),
  notBuilt: z
    .array(
      z.object({
        what: z.string().describe("The brief's id or heading"),
        why: z.string().describe("The user's own words that exclude it (from the brief or an answer), or what it is when it is not something to build (a risk, a term)"),
      }),
    )
    .describe('Parts of the brief that get no task: only what the user excluded in so many words, and items that are not requirements. Never a phase, a priority or your own judgement of what can wait'),
});

export type BriefProposalOutput = z.infer<typeof BriefProposalSchema>;
