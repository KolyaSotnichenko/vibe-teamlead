/**
 * A task's pipeline in the worker: the decision is made once, when the task starts, kept in
 * the task's metadata, and read by the build (shared/pipeline.ts has the rules).
 *
 * The metadata file is in the spec directory, where agents write too, like the other path
 * flags (quick-fix.ts). A lighter pipeline only leaves out agents, never the app's own checks,
 * and a task built by one session never merges by itself (no QA approval is recorded), so the
 * owner always sees it. No Electron imports.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type PipelineDecision, type PipelineKind, pipelineOf, raisedPipeline } from '../../../shared/pipeline';
import { writeFileReplacing } from '../safe-write';
import { safeParseJson } from '../../utils/json-repair';

const METADATA_FILE = 'task_metadata.json';

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = safeParseJson<Record<string, unknown>>(await readFile(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The pipeline decided for the task in this spec directory, if any. Never throws. */
export async function decidedPipeline(specDir: string): Promise<PipelineDecision | undefined> {
  return pipelineOf(await readJson(join(specDir, METADATA_FILE)));
}

/**
 * Keep a decision on the task. One already there stands unless the new one is the user's or
 * heavier (shared/pipeline.ts raisedPipeline). Returns the decision that stands. Never throws:
 * a task whose metadata can't be written runs the pipeline just decided.
 */
export async function recordPipeline(specDir: string, decision: PipelineDecision): Promise<PipelineDecision> {
  const file = join(specDir, METADATA_FILE);
  const metadata = (await readJson(file)) ?? {};
  const stands = raisedPipeline(pipelineOf(metadata), decision);
  try {
    await writeFileReplacing(file, JSON.stringify({ ...metadata, pipelineDecision: stands }, null, 2), 'utf-8');
  } catch {
    // The run goes on with what was decided
  }
  return stands;
}

/**
 * The task's own words out of the first message of a spec run (agent/spec-task-message.ts),
 * without the lines the app adds around them: the rules look at what the user wrote. Pure.
 */
export function taskTextOf(firstMessage: string): string {
  return /^Task: ([\s\S]*?)\n\nProject directory:/.exec(firstMessage)?.[1] ?? firstMessage;
}

/** One line for the task's log */
export function pipelineLogLine(decision: PipelineDecision): string {
  const NAMES: Record<PipelineKind, string> = {
    full: 'full (spec, design, architecture, plan, code, QA)',
    short: 'short (short spec, code, QA; no designer or architect)',
    single: "one session (one agent writes the criteria, tests and code; then the app's checks)",
  };
  const WHY: Record<PipelineDecision['reason'], string> = {
    chosen: 'chosen in the task',
    brief: 'the task comes from a spec document',
    architecture: 'the architect designs this task',
    quick_fix: 'a quick fix from the preview',
    fix_main: 'the app made this task to repair main',
    sensitive: 'the task is about sign-in, money, personal data, a migration or access',
    assessed: decision.detail ? `the assessor: ${decision.detail}` : 'the complexity assessment',
    not_assessed: 'the task could not be assessed',
  };
  return `Pipeline: ${NAMES[decision.kind]}: ${WHY[decision.reason]}`;
}

export const SINGLE_SESSION_SUBTASK_ID = '1-1';

/**
 * What a one-session task has instead of a spec writer and a planner: a spec with the request
 * and an empty list of acceptance criteria for the agent to write first, and a plan of one
 * subtask, so the build runs exactly one coder. The plan file may already hold the task's
 * status (the app keeps it there before a plan exists); only the plan itself is set.
 */
export async function writeSingleSessionPlan(specDir: string, task: { title?: string; description: string }): Promise<void> {
  const planFile = join(specDir, 'implementation_plan.json');
  const plan = (await readJson(planFile)) ?? {};
  // The app writes the task's title into the plan file when it creates the task
  const named = typeof plan.feature === 'string' && plan.feature.trim() ? plan.feature : task.title;
  const title = (named ?? task.description.split('\n')[0]).trim().slice(0, 120) || 'Task';
  const specFile = join(specDir, 'spec.md');
  const existingSpec = await readFile(specFile, 'utf-8').catch(() => '');
  if (!existingSpec.trim()) {
    const spec = [
      `# ${title}`,
      '',
      '## Request',
      '',
      task.description.trim() || title,
      '',
      '## Acceptance criteria',
      '',
      '<!-- One session builds this task. The agent writes the criteria here (AC-1, AC-2, …), each with its test level, before any code. -->',
      '',
    ].join('\n');
    await writeFileReplacing(specFile, spec, 'utf-8');
  }

  const phases = [
    {
      id: '1',
      name: 'Build',
      depends_on: [],
      subtasks: [
        {
          id: SINGLE_SESSION_SUBTASK_ID,
          title: title.slice(0, 80),
          description:
            'One session builds this whole task. First write the acceptance criteria into spec.md (AC-1, AC-2, …, each with its test level). ' +
            'Then, for each criterion, write the failing test, make it pass and tidy up. Commit when the tests pass.',
          status: 'pending',
          files_to_create: [],
          files_to_modify: [],
        },
      ],
    },
  ];
  await writeFileReplacing(planFile, JSON.stringify({ feature: title, workflow_type: 'simple', ...plan, phases, updated_at: new Date().toISOString() }, null, 2), 'utf-8');
}

/** Added to the coder's prompt when one session builds the task */
export const SINGLE_SESSION_INSTRUCTIONS = `
## One session builds this task

Nobody wrote a spec or a plan for this task, and no QA reviewer comes after you: you are the whole team. The owner asked for it to be built in one go.

1. **Criteria first.** Before any code, write the acceptance criteria into \`spec.md\` under "Acceptance criteria": \`AC-1\`, \`AC-2\`, …, each one observable (Given / When / Then) and with its test level (unit, integration, e2e). Keep to what the request asks; do not add scope. If the request leaves a decision that is the owner's, ask with AskUserQuestion; otherwise decide and note the assumption in \`spec.md\`.
2. **Test first.** For each criterion: write the failing test, see it fail, make it pass, tidy up. Every criterion ends with a test that really checks it.
3. **Finish.** Run the project's typecheck and tests, commit, and mark the subtask completed in \`implementation_plan.json\`.

After you, the app runs the project's typecheck and tests and the security scanners itself, on a clean copy of what you committed, and the owner reviews the result. Your own report is not proof: only committed code that passes counts.`;
