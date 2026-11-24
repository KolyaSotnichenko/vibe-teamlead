import { describe, expect, it } from 'vitest';

import { ESCALATED_PIPELINE, heavierPipeline, pipelineByRule, pipelineFromAssessment, pipelineOf, pipelineStages, raisedPipeline } from '../pipeline';

describe('which pipeline a task runs', () => {
  describe("the user's choice comes first", () => {
    it('whatever else the task says', () => {
      expect(pipelineByRule({ pipeline: 'single', sourceType: 'brief' }, 'Add sign-in with a password')).toEqual({ kind: 'single', by: 'user', reason: 'chosen' });
      expect(pipelineByRule({ pipeline: 'full', previewQuickFix: true }, 'Fix the typo')).toMatchObject({ kind: 'full', by: 'user' });
    });

    it('"auto", nothing, or something unknown is no choice', () => {
      for (const pipeline of ['auto', undefined, 'turbo', 7]) {
        expect(pipelineByRule({ pipeline }, 'Rename the button')).toBeUndefined();
      }
    });
  });

  describe('Auto: what the app can check itself', () => {
    // The owner: "the AI agent should decide this, not a choice of words"
    it('a task from a spec document is for the assessor, like any other', () => {
      expect(pipelineByRule({ sourceType: 'brief' }, 'Rename the button')).toBeUndefined();
    });

    it('a task the architect must design runs the full pipeline', () => {
      expect(pipelineByRule({ cloudArchitectureDesign: true }, 'Design the cloud')).toMatchObject({ kind: 'full', reason: 'architecture' });
      expect(pipelineByRule({ architectureOnly: true }, 'Design the cloud')).toMatchObject({ kind: 'full', reason: 'architecture' });
    });

    it('a quick fix from the preview and a fix for main run the short one', () => {
      expect(pipelineByRule({ previewQuickFix: true }, 'The button is off by 2px')).toEqual({ kind: 'short', by: 'rule', reason: 'quick_fix' });
      expect(pipelineByRule({ sourceType: 'base-fix' }, 'Fix main: pnpm run test fails')).toEqual({ kind: 'short', by: 'rule', reason: 'fix_main' });
      expect(pipelineByRule({ sourceType: 'deploy' }, 'Fix the failed CI run on main')).toMatchObject({ kind: 'short', reason: 'fix_main' });
    });

    // planner-mhp: every repair of main ran the full pipeline, its text being the failing output
    it("a fix for main stays short whatever its failing output mentions: that's the log, not what the task is about", () => {
      const output = 'Fix main: pnpm run test fails\n FAIL src/authz/roles.test.ts\n migration 0026_offline_sync applied\n auth token expired';
      expect(pipelineByRule({ sourceType: 'base-fix' }, output)).toEqual({ kind: 'short', by: 'rule', reason: 'fix_main' });
      expect(pipelineByRule({ sourceType: 'deploy' }, output)).toMatchObject({ kind: 'short', reason: 'fix_main' });
    });

    it.each([
      'Add sign-in with email and password',
      'Charge the card with Stripe',
      'Migrate the users table to the new schema',
      'Права доступу для адміністраторів',
    ])("what a task is about is the assessor's call, not a match on its words: %s", (text) => {
      expect(pipelineByRule({}, text)).toBeUndefined();
      expect(pipelineByRule({ previewQuickFix: true }, text)).toMatchObject({ kind: 'short', reason: 'quick_fix' });
    });

    it.each(['Sea battle game in the browser', 'Rename the button', 'Зробити гру морський бій', 'Add a dark footer'])(
      'anything else is for the assessor: %s',
      (text) => {
        expect(pipelineByRule({ sourceType: 'manual' }, text)).toBeUndefined();
      },
    );
  });

  describe("the project's default pipeline", () => {
    it('is the pipeline of every task that chose none: from a spec document or about sign-in too', () => {
      expect(pipelineByRule({ sourceType: 'manual' }, 'Sea battle game', 'single')).toEqual({ kind: 'single', by: 'user', reason: 'project_default' });
      expect(pipelineByRule({ sourceType: 'brief' }, 'Add sign-in with a password', 'short')).toMatchObject({ kind: 'short', reason: 'project_default' });
      expect(pipelineByRule(undefined, 'Anything', 'full')).toMatchObject({ kind: 'full', reason: 'project_default' });
    });

    it("gives way to the task's own choice, and to a task that says Auto", () => {
      expect(pipelineByRule({ pipeline: 'full' }, 'Sea battle game', 'single')).toMatchObject({ kind: 'full', reason: 'chosen' });
      expect(pipelineByRule({ pipeline: 'auto' }, 'Sea battle game', 'single')).toBeUndefined();
      expect(pipelineByRule({ pipeline: 'auto', sourceType: 'brief' }, 'Sea battle game', 'single')).toBeUndefined();
    });

    it('does not reach the tasks whose pipeline follows from what they are', () => {
      expect(pipelineByRule({ architectureOnly: true }, 'Design the cloud', 'single')).toMatchObject({ kind: 'full', reason: 'architecture' });
      // A repair of main merges by itself only after a QA review, which one session does not have
      expect(pipelineByRule({ sourceType: 'base-fix' }, 'Fix main: pnpm run test fails', 'single')).toMatchObject({ kind: 'short', reason: 'fix_main' });
      expect(pipelineByRule({ previewQuickFix: true }, 'The button is off by 2px', 'full')).toMatchObject({ kind: 'short', reason: 'quick_fix' });
    });

    it('"auto", nothing or nonsense as the default changes nothing', () => {
      for (const projectDefault of ['auto', undefined, 'turbo']) {
        expect(pipelineByRule({}, 'Rename the button', projectDefault)).toBeUndefined();
      }
    });
  });

  describe('one session that could not finish', () => {
    it('goes on under the short pipeline, whoever chose one session', () => {
      expect(ESCALATED_PIPELINE).toEqual({ kind: 'short', by: 'rule', reason: 'escalated' });
      expect(raisedPipeline({ kind: 'single', by: 'user', reason: 'chosen' }, ESCALATED_PIPELINE)).toBe(ESCALATED_PIPELINE);
      expect(raisedPipeline({ kind: 'single', by: 'assessor', reason: 'assessed' }, ESCALATED_PIPELINE)).toBe(ESCALATED_PIPELINE);
    });

    it('never makes a heavier task lighter', () => {
      const full = { kind: 'full', by: 'rule', reason: 'sensitive' } as const;
      expect(raisedPipeline(full, ESCALATED_PIPELINE)).toBe(full);
    });
  });

  describe('Auto: the assessor', () => {
    it('names the pipeline and says why', () => {
      expect(pipelineFromAssessment({ complexity: 'standard', pipeline: 'single', pipeline_reason: 'One small game in an empty project' })).toEqual({
        kind: 'single',
        by: 'assessor',
        reason: 'assessed',
        detail: 'One small game in an empty project',
      });
      expect(pipelineFromAssessment({ complexity: 'standard', pipeline: 'short' })).toMatchObject({ kind: 'short', by: 'assessor' });
    });

    it('without a named pipeline: a simple task is one session, anything else the full pipeline', () => {
      expect(pipelineFromAssessment({ complexity: 'simple' })).toMatchObject({ kind: 'single', reason: 'assessed' });
      expect(pipelineFromAssessment({ complexity: 'standard' })).toMatchObject({ kind: 'full', reason: 'assessed' });
      expect(pipelineFromAssessment({ complexity: 'complex', pipeline: 'whatever' })).toMatchObject({ kind: 'full' });
    });

    it('a complex task is never light, whatever the assessor named', () => {
      expect(pipelineFromAssessment({ complexity: 'complex', pipeline: 'single' })).toMatchObject({ kind: 'full' });
    });

    it('no assessment is the full pipeline', () => {
      expect(pipelineFromAssessment(undefined)).toEqual({ kind: 'full', by: 'assessor', reason: 'not_assessed' });
      expect(pipelineFromAssessment({})).toMatchObject({ kind: 'full', reason: 'not_assessed' });
    });
  });

  describe('a decision only ever gets heavier by itself', () => {
    it('knows which is heavier', () => {
      expect(heavierPipeline('single', 'short')).toBe('short');
      expect(heavierPipeline('full', 'short')).toBe('full');
      expect(heavierPipeline('single', 'single')).toBe('single');
    });

    it('keeps the heavier of what was decided and what is decided now', () => {
      const light = { kind: 'single', by: 'assessor', reason: 'assessed' } as const;
      const heavy = { kind: 'full', by: 'rule', reason: 'sensitive' } as const;
      expect(raisedPipeline(heavy, light)).toBe(heavy);
      expect(raisedPipeline(light, heavy)).toBe(heavy);
      expect(raisedPipeline(undefined, light)).toBe(light);
    });

    it("but the user's choice replaces anything", () => {
      const heavy = { kind: 'full', by: 'rule', reason: 'sensitive' } as const;
      const chosen = { kind: 'single', by: 'user', reason: 'chosen' } as const;
      expect(raisedPipeline(heavy, chosen)).toBe(chosen);
    });

    it('a choice the user took back (the task is on Auto again) binds nothing', () => {
      const chosen = { kind: 'full', by: 'user', reason: 'chosen' } as const;
      const light = { kind: 'single', by: 'assessor', reason: 'assessed' } as const;
      expect(raisedPipeline(chosen, light)).toBe(light);
    });
  });

  describe('what a task shows', () => {
    it('each pipeline has its own stages, and every one ends with your review', () => {
      expect(pipelineStages('full')).toEqual(['spec', 'designer', 'architect', 'planner', 'coder', 'qa', 'review']);
      expect(pipelineStages('short')).toEqual(['spec', 'coder', 'qa', 'review']);
      expect(pipelineStages('single')).toEqual(['coder', 'qa', 'review']);
    });

    it('reads the decision from the task, and a task without one runs the full pipeline', () => {
      expect(pipelineOf({ pipelineDecision: { kind: 'short', by: 'rule', reason: 'quick_fix' } })).toMatchObject({ kind: 'short' });
      expect(pipelineOf({ pipelineDecision: { kind: 'express' } })).toBeUndefined();
      expect(pipelineOf(undefined)).toBeUndefined();
      expect(pipelineOf('nonsense')).toBeUndefined();
    });
  });
});
