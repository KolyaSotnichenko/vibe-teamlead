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
});

export const BriefProposalSchema = z.object({
  title: z.string().describe('Name of what the brief describes'),
  summary: z.string().describe('2–4 sentences: what will be built, and what was left for later if anything'),
  epics: z.array(z.object({ key: z.string(), title: z.string(), summary: z.string() })),
  tasks: z.array(BriefTaskSchema),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export type BriefProposalOutput = z.infer<typeof BriefProposalSchema>;
