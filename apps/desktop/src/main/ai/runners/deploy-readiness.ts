/**
 * Deploy readiness scan: a read-only agent reads the project and names what stands between it
 * and a first Vercel deploy. The only model call of the readiness feature; everything around it
 * (store, tasks, UI) is plain code.
 */

import { z } from 'zod';

import { getFeatureSettings } from '../../ipc-handlers/feature-settings-helper';
import type { ReadinessBlocker, ReadinessOwnerItem, ReadinessResult, ServiceKind } from '../../../shared/types/deploy';
import { clip, clipLine } from '../../deploy/clip';
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
  /** `sha`: the commit the run was of (the scan gets the run only when it is the commit scanned) */
  lastMainRun?: { conclusion: string; runId: number; failedJobs: string[]; workflowPath?: string; sha?: string };
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

const TITLE_CHARS = 120;
const SUBJECT_CHARS = 120;
const DETAIL_CHARS = 2000;
const OWNER_MESSAGE_CHARS = 500;

/**
 * A blocker that only says variables aren't configured (for example "Required API env vars are
 * not configured"): the prompt makes those owner items, this catches the ones that slip through.
 * Matched on the subject and title only, which must say both "variables/secrets" and "not
 * configured/missing"; "Missing env validation" or "Hardcoded localhost" don't match.
 */
const UNCONFIGURED_VARIABLES = [
  /\b(?:env(?:ironment)?\s+var(?:iable)?s?|variables?|secrets?)\b[^.]*\b(?:not\s+(?:configured|set|defined|provided)|missing|unset|unconfigured)\b/i,
  /\b(?:missing|unset|unconfigured|undefined)\s+(?:required\s+)?(?:env(?:ironment)?\s+)?(?:var(?:iable)?s?|secrets?)\b/i,
];
/** Variable names as code reads them: upper case with at least one underscore */
const VARIABLE_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
/** Set by Vercel itself, never by the owner */
const PLATFORM_VARIABLE = (name: string) => name.startsWith('VERCEL_') || name === 'NODE_ENV' || name === 'CI';

/** The variables an "unconfigured variables" blocker names, or undefined when it isn't one (or names none). */
function unconfiguredVariables(blocker: { kind: string; subject: string; title: string; detail: string }): string[] | undefined {
  if (blocker.kind !== 'code' && blocker.kind !== 'workflow') return undefined;
  const head = `${blocker.subject}. ${blocker.title}`;
  if (!UNCONFIGURED_VARIABLES.some((pattern) => pattern.test(head))) return undefined;
  const names = [...new Set(`${blocker.title} ${blocker.detail}`.match(VARIABLE_NAME) ?? [])];
  return names.length ? names : undefined;
}

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

  const owner: ReadinessOwnerItem[] = result.output.owner.map((item) => ({ ...item, message: clip(item.message, OWNER_MESSAGE_CHARS) }));
  const configured = new Set(input.variableNames);
  const seen = new Set<string>();
  const blockers: ReadinessBlocker[] = [];
  for (const raw of result.output.blockers) {
    // Only the owner can set a variable: an owner item with a value field, not a task
    const variables = unconfiguredVariables(raw);
    if (variables) {
      for (const name of variables) {
        if (configured.has(name) || PLATFORM_VARIABLE(name) || owner.some((item) => item.variable === name)) continue;
        owner.push({ kind: 'variable', variable: name, message: clip(`The deployed app needs ${name}.`, OWNER_MESSAGE_CHARS) });
      }
      continue;
    }
    // Clipped after parsing: a long answer is cut, it doesn't fail the scan
    const blocker = {
      kind: raw.kind,
      subject: clipLine(raw.subject, SUBJECT_CHARS),
      title: clipLine(raw.title, TITLE_CHARS),
      detail: clip(raw.detail, DETAIL_CHARS),
    };
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
    owner,
    workflow: {
      path: result.output.workflowPath,
      lastMainRun: input.lastMainRun ? { conclusion: input.lastMainRun.conclusion, runId: input.lastMainRun.runId } : undefined,
    },
  };
}
