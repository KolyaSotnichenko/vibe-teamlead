/**
 * Deploy readiness scan: a read-only agent reads the project and names what stands between it
 * and a first Vercel deploy. The only model call of the readiness feature; everything around it
 * (store, tasks, UI) is plain code.
 */

import { z } from 'zod';

import { getFeatureSettings } from '../../ipc-handlers/feature-settings-helper';
import type { ReadinessBlocker, ReadinessResult, ServiceKind } from '../../../shared/types/deploy';
import { blockerKey } from '../../deploy/readiness-store';
import { READ_TOOLS, runClaudeTask } from '../claude-code/task';
import type { ThinkingLevel } from '../config/types';
import { loadPrompt } from '../prompts/prompt-loader';

export interface ScanInput {
  projectPath: string;
  commit?: string;
  /** Names only, never values */
  variableNames: string[];
  databaseAdded: boolean;
  servicesAdded: ServiceKind[];
  lastMainRun?: { conclusion: string; runId: number; failedJobs: string[]; workflowPath?: string };
}

/** The agent's part of a ReadinessResult. Plain objects and enums only (the SDK enforces its JSON Schema). */
export const ReadinessScanSchema = z.object({
  blockers: z.array(
    z.object({
      kind: z.enum(['code', 'workflow', 'unsupported']),
      subject: z.string(),
      title: z.string(),
      detail: z.string(),
    }),
  ),
  services: z.array(
    z.object({
      kind: z.enum(['postgres', 'redis', 'blob', 'other']),
      name: z.string(),
      managed: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  owner: z.array(
    z.object({
      kind: z.enum(['variable', 'other']),
      variable: z.string().optional(),
      message: z.string(),
    }),
  ),
  workflowPath: z.string().optional(),
});

export interface ReadinessScanDeps {
  run?: typeof runClaudeTask;
  feature?: () => { model: string; thinkingLevel: string };
  now?: () => Date;
}

/** The user prompt: names and facts only, no values. Pure. */
export function readinessPrompt(input: ScanInput): string {
  const lines = [
    `The project root is ${input.projectPath}.`,
    input.commit ? `Scan the code at commit ${input.commit}.` : 'Scan the code as it is checked out.',
    `Environment variable names already configured on Vercel: ${input.variableNames.length ? input.variableNames.join(', ') : 'none'}.`,
    `Database added on Vercel: ${input.databaseAdded ? 'yes' : 'no'}.`,
    `Services already added: ${input.servicesAdded.length ? input.servicesAdded.join(', ') : 'none'}.`,
  ];
  const run = input.lastMainRun;
  if (run) {
    lines.push(
      `The last CI run on main (run ${run.runId}) ended with: ${run.conclusion}.`,
      `Failed jobs: ${run.failedJobs.length ? run.failedJobs.join(', ') : 'none'}.`,
      run.workflowPath ? `Its workflow file: ${run.workflowPath}.` : 'Its workflow file is unknown.',
    );
  } else {
    lines.push('There is no CI run on main yet.');
  }
  lines.push('Report what blocks a first deploy, as described in your instructions.');
  return lines.join('\n');
}

export async function runReadinessScan(input: ScanInput, deps: ReadinessScanDeps = {}): Promise<ReadinessResult> {
  const run = deps.run ?? runClaudeTask;
  const feature = (deps.feature ?? (() => getFeatureSettings('deployReadiness')))();
  const now = deps.now ?? (() => new Date());

  const result = await run({
    systemPrompt: loadPrompt('deploy_readiness'),
    prompt: readinessPrompt(input),
    model: feature.model,
    thinkingLevel: feature.thinkingLevel as ThinkingLevel,
    tools: READ_TOOLS,
    cwd: input.projectPath,
    agentType: 'deploy_readiness',
    outputSchema: ReadinessScanSchema,
    maxTurns: 40,
  });
  if (!result.output) throw new Error('The readiness scan returned no result. Try again.');

  const seen = new Set<string>();
  const blockers: ReadinessBlocker[] = [];
  for (const blocker of result.output.blockers) {
    const key = blockerKey(blocker.kind, blocker.subject);
    if (seen.has(key)) continue;
    seen.add(key);
    blockers.push({ ...blocker, key });
  }

  return {
    scannedAt: now().toISOString(),
    commit: input.commit,
    blockers,
    services: result.output.services,
    owner: result.output.owner,
    workflow: {
      path: result.output.workflowPath,
      lastMainRun: input.lastMainRun ? { conclusion: input.lastMainRun.conclusion, runId: input.lastMainRun.runId } : undefined,
    },
  };
}
