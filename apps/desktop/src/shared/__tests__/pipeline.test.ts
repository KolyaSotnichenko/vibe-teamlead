import { describe, expect, it } from 'vitest';

import { heavierPipeline, pipelineByRule, pipelineFromAssessment, pipelineOf, pipelineStages, raisedPipeline } from '../pipeline';

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
    it('a task from a spec document runs the full pipeline', () => {
      expect(pipelineByRule({ sourceType: 'brief' }, 'Rename the button')).toEqual({ kind: 'full', by: 'rule', reason: 'brief' });
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

    it.each([
      'Add sign-in with email and password',
      'Users log in with Google OAuth',
      'Charge the card with Stripe',
      'Add a payment page',
      'Store personal data of customers',
      'Migrate the users table to the new schema',
      'Add a database migration for orders',
      'Roles and permissions for admins',
      'Rotate the API key',
      'Додати авторизацію через пошту',
      'Вхід за паролем',
      'Оплата карткою',
      'Зберігати персональні дані клієнтів',
      'Міграція бази даних',
      'Права доступу для адміністраторів',
    ])('sign-in, money, personal data, migrations and access run the full one: %s', (text) => {
      expect(pipelineByRule({}, text)).toEqual({ kind: 'full', by: 'rule', reason: 'sensitive' });
    });

    it('a quick fix that touches sign-in is still not light: the heavier rule wins', () => {
      expect(pipelineByRule({ previewQuickFix: true }, 'The password field loses focus')).toMatchObject({ kind: 'full', reason: 'sensitive' });
    });

    it.each(['Sea battle game in the browser', 'Rename the button', 'Зробити гру морський бій', 'Add a dark footer'])(
      'anything else is for the assessor: %s',
      (text) => {
        expect(pipelineByRule({ sourceType: 'manual' }, text)).toBeUndefined();
      },
    );
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
