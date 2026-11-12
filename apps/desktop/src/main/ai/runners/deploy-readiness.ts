/**
 * CI readiness scan: a read-only agent reads the project and names what keeps its GitHub Actions
 * CI from passing, and the CI secrets GitHub lacks. The only model call of the readiness feature;
 * everything around it (store, tasks, UI) is plain code.
 */

import { z } from 'zod';

import { getFeatureSettings } from '../../ipc-handlers/feature-settings-helper';
import type { ReadinessBlocker, ReadinessOwnerItem, ReadinessResult } from '../../../shared/types/deploy';
import { clip, clipLine } from '../../deploy/clip';
import { isValidSecretName } from '../../../shared/utils/github-secret-name';
import { assignKnownKeys, blockerKey, type KnownBlocker, knownSubject } from '../../deploy/readiness-store';
import { READ_TOOLS, runClaudeTask } from '../claude-code/task';
import type { ThinkingLevel } from '../config/types';
import { loadPrompt } from '../prompts/prompt-loader';

export interface ScanInput {
  projectPath: string;
  commit?: string;
  /** The repository's GitHub Actions secret names; never values */
  secretNames: string[];
  /** `sha`: the commit the run was of (the scan gets the run only when it is the commit scanned) */
  lastMainRun?: { conclusion: string; runId: number; failedJobs: string[]; workflowPath?: string; sha?: string };
  /** Blockers already known (the saved scan's, open tasks'): a problem found again keeps its key */
  knownBlockers?: KnownBlocker[];
}

/** Known blockers named in the prompt, at most */
export const KNOWN_IN_PROMPT = 30;

/** The agent's part of a ReadinessResult. Plain objects and enums only (the SDK enforces its JSON Schema). */
export const ReadinessScanSchema = z.object({
  blockers: z.array(
    z.object({
      kind: z.enum(['code', 'workflow']),
      subject: z.string(),
      title: z.string(),
      detail: z.string(),
      /** The key of the known blocker this one is, when it is one */
      sameAs: z.string().optional(),
    }),
  ),
  owner: z.array(
    z.object({
      kind: z.enum(['secret', 'other']),
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
 * A code blocker that only says variables aren't configured (for example "Required API env vars
 * are not configured"): only the owner can supply a value, as a GitHub Actions secret. The prompt
 * makes those owner `secret` items; this catches the ones that slip through. Matched on the title only, where the missing wording must apply to env vars, secrets
 * or a named UPPER_SNAKE variable: "Env var validation is missing" and "Undefined variable breaks
 * the build" don't match. Workflow blockers are left alone (a CI gap is often an agent's fix).
 */
const SNAKE = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+';
const MISSING = '(?:(?:are|is)\\s+)?(?:still\\s+)?(?:not\\s+(?:set|configured|defined|provided)|missing|unset|unconfigured)\\b';
const UNCONFIGURED_VARIABLES = [
  // "API env vars are not configured", "Secrets missing"
  new RegExp(`\\b(?:env(?:ironment)?\\s+var(?:iable)?s?|secrets?)\\s+${MISSING}`, 'i'),
  // "API_BASE_URL is not set", "CSRF_SECRET and WEB_ORIGIN are missing"
  new RegExp(`\\b${SNAKE}(?:\\s*(?:,|and)\\s*${SNAKE})*\\s+${MISSING}`),
  // "Missing env vars", "Missing required secrets: ..."
  /\b(?:missing|unset|unconfigured)\s+(?:required\s+)?(?:env(?:ironment)?\s+var(?:iable)?s?|secrets?)\b(?!\s+(?:validation|schema|checks?|parsing|loading|loader|handling|names?)\b)/i,
  // "Missing API_KEY"
  new RegExp(`\\b(?:[Mm]issing|[Uu]nset)\\s+${SNAKE}\\b`),
];
/** Variable names as code reads them: upper case with at least one underscore */
const VARIABLE_NAME = new RegExp(`\\b${SNAKE}\\b`, 'g');
/** Set by GitHub Actions itself (GITHUB_TOKEN and the like), never by the owner; GitHub refuses such secret names */
const PLATFORM_VARIABLE = (name: string) => name.startsWith('GITHUB_');

/** The variables an "unconfigured variables" code blocker names (the title's, else the detail's), or undefined when it isn't one or names none. */
function unconfiguredVariables(blocker: { kind: string; title: string; detail: string }): string[] | undefined {
  if (blocker.kind !== 'code') return undefined;
  if (!UNCONFIGURED_VARIABLES.some((pattern) => pattern.test(blocker.title))) return undefined;
  const fromTitle = blocker.title.match(VARIABLE_NAME) ?? [];
  const names = [...new Set(fromTitle.length ? fromTitle : (blocker.detail.match(VARIABLE_NAME) ?? []))];
  return names.length ? names : undefined;
}

/**
 * The model's owner items, cleaned: a secret by its name as GitHub stores it (upper case), once;
 * none GitHub has already or sets itself; a secret without a name GitHub accepts is an `other`
 * item (its message still says what is needed). Messages clipped. Pure.
 */
function ownerItems(items: Array<{ kind: 'secret' | 'other'; variable?: string; message: string }>, configured: ReadonlySet<string>): ReadinessOwnerItem[] {
  const out: ReadinessOwnerItem[] = [];
  for (const item of items) {
    const message = clip(item.message, OWNER_MESSAGE_CHARS);
    if (item.kind !== 'secret') {
      out.push({ kind: 'other', message });
      continue;
    }
    const name = (item.variable ?? '').trim().toUpperCase();
    if (PLATFORM_VARIABLE(name) || configured.has(name) || out.some((o) => o.kind === 'secret' && o.variable === name)) continue;
    out.push(isValidSecretName(name) ? { kind: 'secret', variable: name, message } : { kind: 'other', message });
  }
  return out;
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
    `GitHub Actions secret names the repository already has: ${input.secretNames.length ? input.secretNames.join(', ') : 'none'}.`,
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
  const known = (input.knownBlockers ?? []).filter((b) => b.kind === 'code' || b.kind === 'workflow').slice(0, KNOWN_IN_PROMPT);
  if (known.length) {
    lines.push(
      'Known blockers (key, kind, subject: title):',
      ...known.map((b) => `- ${b.key} (${b.kind}) subject "${clipLine(knownSubject(b), SUBJECT_CHARS)}": ${clipLine(b.title, TITLE_CHARS)}`),
      'If a problem you find is one of these, put its key in sameAs and reuse its subject exactly.',
    );
  }
  lines.push('Report what keeps CI from passing, as described in your instructions.');
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

  const configured = new Set(input.secretNames.map((name) => name.toUpperCase()));
  const owner = ownerItems(result.output.owner, configured);
  const candidates: Array<{ kind: ReadinessBlocker['kind']; subject: string; title: string; detail: string; sameAs?: string }> = [];
  for (const raw of result.output.blockers) {
    // Only the owner can supply a value: a secret item they save to GitHub, not a task
    const variables = unconfiguredVariables(raw);
    if (variables) {
      let added = 0;
      for (const name of variables) {
        if (configured.has(name) || PLATFORM_VARIABLE(name) || owner.some((item) => item.variable === name)) continue;
        owner.push({ kind: 'secret', variable: name, message: clip(`CI needs the secret ${name}.`, OWNER_MESSAGE_CHARS) });
        added++;
      }
      // Dropped only when the owner now has every variable it names; otherwise it stays a blocker
      const listed = variables.every((name) => owner.some((item) => item.variable === name));
      if (added > 0 || listed) continue;
    }
    // Clipped after parsing: a long answer is cut, it doesn't fail the scan
    candidates.push({
      kind: raw.kind,
      subject: clipLine(raw.subject, SUBJECT_CHARS),
      title: clipLine(raw.title, TITLE_CHARS),
      detail: clip(raw.detail, DETAIL_CHARS),
      ...(raw.sameAs ? { sameAs: raw.sameAs } : {}),
    });
  }
  // The same problem found again keeps the key it has (and its task)
  const knownKeys = assignKnownKeys(candidates, input.knownBlockers ?? []);
  const seen = new Set<string>();
  const blockers: ReadinessBlocker[] = [];
  candidates.forEach(({ sameAs: _sameAs, ...blocker }, i) => {
    const key = knownKeys[i] ?? blockerKey(blocker.kind, blocker.subject);
    if (seen.has(key)) return;
    seen.add(key);
    blockers.push({ ...blocker, key });
  });

  return {
    scannedAt: now().toISOString(),
    commit: input.commit,
    blockers,
    owner,
    workflow: {
      path: result.output.workflowPath,
      lastMainRun: input.lastMainRun ? { conclusion: input.lastMainRun.conclusion, runId: input.lastMainRun.runId } : undefined,
    },
  };
}
