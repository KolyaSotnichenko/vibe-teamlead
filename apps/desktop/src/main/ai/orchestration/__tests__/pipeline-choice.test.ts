import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { ImplementationPlanSchema } from '../../schema/implementation-plan';
import { specTaskMessage } from '../../../agent/spec-task-message';
import { decidedPipeline, escalateSingleSession, pipelineLogLine, recordPipeline, SINGLE_SESSION_SUBTASK_ID, singleSessionRanOut, taskTextOf, writeSingleSessionPlan } from '../pipeline-choice';

describe("a task's pipeline in its metadata", () => {
  let specDir: string;
  const metadata = () => JSON.parse(readFileSync(join(specDir, 'task_metadata.json'), 'utf-8'));

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), 'vtl-pipeline-'));
  });

  it('keeps the decision next to what the task already says about itself', async () => {
    writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({ sourceType: 'manual', category: 'feature' }));

    const stands = await recordPipeline(specDir, { kind: 'short', by: 'rule', reason: 'quick_fix' });

    expect(stands.kind).toBe('short');
    expect(metadata()).toEqual({ sourceType: 'manual', category: 'feature', pipelineDecision: { kind: 'short', by: 'rule', reason: 'quick_fix' } });
    expect(await decidedPipeline(specDir)).toMatchObject({ kind: 'short', reason: 'quick_fix' });
  });

  it('works for a task with no metadata file yet', async () => {
    await recordPipeline(specDir, { kind: 'single', by: 'assessor', reason: 'assessed' });
    expect(await decidedPipeline(specDir)).toMatchObject({ kind: 'single' });
  });

  it('a later automatic decision can only make the task heavier', async () => {
    await recordPipeline(specDir, { kind: 'full', by: 'rule', reason: 'sensitive' });
    expect((await recordPipeline(specDir, { kind: 'single', by: 'assessor', reason: 'assessed' })).kind).toBe('full');
    expect((await decidedPipeline(specDir))?.kind).toBe('full');

    await recordPipeline(specDir, { kind: 'single', by: 'user', reason: 'chosen' });
    expect(await decidedPipeline(specDir)).toMatchObject({ kind: 'single', by: 'user' });
  });

  it('no decision when the file is missing, damaged or names no pipeline', async () => {
    expect(await decidedPipeline(specDir)).toBeUndefined();
    writeFileSync(join(specDir, 'task_metadata.json'), '{ not json');
    expect(await decidedPipeline(specDir)).toBeUndefined();
  });

  it("looks at the task's own words, not at the lines the app adds to the first message", () => {
    const message = specTaskMessage({ taskDescription: 'Sea battle\n\nA game for two.', projectPath: '/Users/x/auth-service', requireReview: false });
    expect(taskTextOf(message)).toBe('Sea battle\n\nA game for two.');
    expect(taskTextOf('Just build it')).toBe('Just build it');
  });

  it('says in the log which pipeline runs and why', () => {
    expect(pipelineLogLine({ kind: 'single', by: 'assessor', reason: 'assessed', detail: 'a small game in an empty project' })).toBe(
      "Pipeline: one session (one agent writes the criteria, tests and code; then the app's checks): the assessor: a small game in an empty project",
    );
    expect(pipelineLogLine({ kind: 'full', by: 'rule', reason: 'sensitive' })).toMatch(/^Pipeline: full .*sign-in, money/);
  });
});

describe('what one session gets instead of a spec writer and a planner', () => {
  let specDir: string;
  const read = (file: string) => readFileSync(join(specDir, file), 'utf-8');

  beforeEach(() => {
    specDir = mkdtempSync(join(tmpdir(), 'vtl-single-'));
  });

  it('a spec with the request and a place for the criteria the agent writes first', async () => {
    await writeSingleSessionPlan(specDir, { title: 'Sea battle', description: 'A sea battle game for two players in the browser.' });

    const spec = read('spec.md');
    expect(spec).toContain('# Sea battle');
    expect(spec).toContain('A sea battle game for two players in the browser.');
    expect(spec).toContain('## Acceptance criteria');
  });

  it('a valid plan of exactly one pending subtask, so the build runs one coder', async () => {
    await writeSingleSessionPlan(specDir, { title: 'Sea battle', description: 'A game.' });

    const plan = ImplementationPlanSchema.parse(JSON.parse(read('implementation_plan.json')));
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].subtasks).toHaveLength(1);
    expect(plan.phases[0].subtasks[0]).toMatchObject({ id: SINGLE_SESSION_SUBTASK_ID, status: 'pending' });
  });

  it("keeps the task's status the app wrote into the plan file before there was a plan", async () => {
    writeFileSync(join(specDir, 'implementation_plan.json'), JSON.stringify({ feature: 'Sea battle game', status: 'in_progress', xstateState: 'planning', phases: [] }));

    await writeSingleSessionPlan(specDir, { description: 'A game.' });

    const plan = JSON.parse(read('implementation_plan.json'));
    expect(plan).toMatchObject({ feature: 'Sea battle game', status: 'in_progress', xstateState: 'planning' });
    expect(plan.phases[0].subtasks).toHaveLength(1);
    expect(read('spec.md')).toContain('# Sea battle game');
  });

  it('leaves a spec that is already there', async () => {
    writeFileSync(join(specDir, 'spec.md'), '# Mine\n\n- AC-1 already written\n');
    await writeSingleSessionPlan(specDir, { title: 'Sea battle', description: 'A game.' });
    expect(read('spec.md')).toBe('# Mine\n\n- AC-1 already written\n');
  });
});

describe('one session that could not finish goes on under the short pipeline', () => {
  let specDir: string;
  let sourceSpecDir: string;
  const json = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), 'utf-8'));

  beforeEach(async () => {
    specDir = mkdtempSync(join(tmpdir(), 'vtl-escalate-'));
    sourceSpecDir = mkdtempSync(join(tmpdir(), 'vtl-escalate-source-'));
    for (const dir of [specDir, sourceSpecDir]) await recordPipeline(dir, { kind: 'single', by: 'assessor', reason: 'assessed' });
    await writeSingleSessionPlan(specDir, { title: 'Sea battle', description: 'A game.' });
  });

  describe('when', () => {
    const ranOut = { success: false, stuckSubtasks: ['1-1'], gaveUpSubtasks: [] };

    it('the session used up its tries without finishing', () => {
      expect(singleSessionRanOut('single', ranOut, false)).toBe(true);
    });

    it('not when the build succeeded, was stopped, or failed for another reason', () => {
      expect(singleSessionRanOut('single', { success: true }, false)).toBe(false);
      expect(singleSessionRanOut('single', ranOut, true)).toBe(false);
      expect(singleSessionRanOut('single', { success: false }, false)).toBe(false);
    });

    it('not when the coder gave up and wrote why: that waits for the owner', () => {
      expect(singleSessionRanOut('single', { success: false, stuckSubtasks: ['1-1'], gaveUpSubtasks: ['1-1'] }, false)).toBe(false);
    });

    it('only a one-session task: the others already have a plan and a reviewer', () => {
      expect(singleSessionRanOut('short', ranOut, false)).toBe(false);
      expect(singleSessionRanOut('full', ranOut, false)).toBe(false);
    });
  });

  it('records the short pipeline where the build and the window read it, and says why', async () => {
    expect(await escalateSingleSession(specDir, sourceSpecDir)).toBe(true);

    for (const dir of [specDir, sourceSpecDir]) {
      expect(json(dir, 'task_metadata.json').pipelineDecision).toEqual({ kind: 'short', by: 'rule', reason: 'escalated' });
    }
  });

  it("empties the plan so the build plans what is left, and keeps the task's status and the spec", async () => {
    const planFile = join(specDir, 'implementation_plan.json');
    writeFileSync(planFile, JSON.stringify({ ...json(specDir, 'implementation_plan.json'), status: 'in_progress', xstateState: 'coding' }));
    const spec = readFileSync(join(specDir, 'spec.md'), 'utf-8');

    await escalateSingleSession(specDir, sourceSpecDir);

    expect(json(specDir, 'implementation_plan.json')).toMatchObject({ feature: 'Sea battle', status: 'in_progress', xstateState: 'coding', phases: [] });
    expect(readFileSync(join(specDir, 'spec.md'), 'utf-8')).toBe(spec);
  });

  it("the user's own choice of one session goes on too: a task that cannot finish helps nobody", async () => {
    await recordPipeline(specDir, { kind: 'single', by: 'user', reason: 'chosen' });
    expect(await escalateSingleSession(specDir)).toBe(true);
    expect((await decidedPipeline(specDir))?.kind).toBe('short');
  });

  it('does nothing to a task that is not a one-session task', async () => {
    await recordPipeline(specDir, { kind: 'full', by: 'user', reason: 'chosen' });
    const plan = readFileSync(join(specDir, 'implementation_plan.json'), 'utf-8');

    expect(await escalateSingleSession(specDir, sourceSpecDir)).toBe(false);

    expect((await decidedPipeline(specDir))?.kind).toBe('full');
    expect(readFileSync(join(specDir, 'implementation_plan.json'), 'utf-8')).toBe(plan);
  });
});
