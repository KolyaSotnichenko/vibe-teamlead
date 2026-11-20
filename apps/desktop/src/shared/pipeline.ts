/**
 * Which pipeline a task runs.
 *
 * - full: spec → design → architecture → plan → code → QA → your review. As it always was.
 * - short: a short spec with acceptance criteria and its plan → code → QA → your review.
 *   No designer, no architect.
 * - single: one agent session writes the acceptance criteria, the tests and the code; the app's
 *   own checks and scanners still run (they call no model); then your review. No spec writer,
 *   designer, architect, planner or QA reviewer, so it never merges by itself.
 *
 * The user's choice in the task comes first. "Auto" first looks at what the app can check itself
 * (where the task came from, words about sign-in, money, personal data, migrations, access), and
 * only then asks the complexity assessor. Whatever decides without the user may only make a task
 * heavier, never lighter. Shared by the main process and the renderer: no imports.
 */

/** Lightest first */
export const PIPELINE_KINDS = ['single', 'short', 'full'] as const;
export type PipelineKind = (typeof PIPELINE_KINDS)[number];
/** What the user picks in the task; "auto" (or nothing) lets the app decide */
export type PipelineChoice = 'auto' | PipelineKind;

export type PipelineReason =
  /** The user picked it in the task */
  | 'chosen'
  /** The task comes from a spec document: part of a larger product */
  | 'brief'
  /** The architect must design it */
  | 'architecture'
  /** A quick fix from Preview notes */
  | 'quick_fix'
  /** The app made the task to repair main or CI */
  | 'fix_main'
  /** Sign-in, money, personal data, a migration or access */
  | 'sensitive'
  /** The complexity assessor's call (its words in `detail`) */
  | 'assessed'
  /** The assessment did not happen */
  | 'not_assessed';

export interface PipelineDecision {
  kind: PipelineKind;
  by: 'user' | 'rule' | 'assessor';
  reason: PipelineReason;
  /** The assessor's own reason, in its words */
  detail?: string;
}

export type PipelineStage = 'spec' | 'designer' | 'architect' | 'planner' | 'coder' | 'qa' | 'review';

const STAGES: Record<PipelineKind, PipelineStage[]> = {
  full: ['spec', 'designer', 'architect', 'planner', 'coder', 'qa', 'review'],
  short: ['spec', 'coder', 'qa', 'review'],
  // 'qa' here is the app's own checks and scanners: no reviewer agent
  single: ['coder', 'qa', 'review'],
};

/** The stages a task of this pipeline goes through, in order. A fresh array. */
export function pipelineStages(kind: PipelineKind): PipelineStage[] {
  return [...STAGES[kind]];
}

export function isPipelineKind(value: unknown): value is PipelineKind {
  return typeof value === 'string' && (PIPELINE_KINDS as readonly string[]).includes(value);
}

export function heavierPipeline(a: PipelineKind, b: PipelineKind): PipelineKind {
  return PIPELINE_KINDS.indexOf(a) >= PIPELINE_KINDS.indexOf(b) ? a : b;
}

/**
 * The decision that stands when a new one is made for a task that already has one: the user's
 * choice replaces anything, and so does whatever follows a choice the user took back; otherwise
 * the heavier of the two, so nothing but the user makes a task lighter. Pure.
 */
export function raisedPipeline(earlier: PipelineDecision | undefined, now: PipelineDecision): PipelineDecision {
  // An earlier choice of the user that they have since taken back (or it would be `now`) binds nothing
  if (!earlier || now.by === 'user' || earlier.by === 'user') return now;
  return heavierPipeline(earlier.kind, now.kind) === now.kind && now.kind !== earlier.kind ? now : earlier;
}

/**
 * Sign-in, money, personal data, migrations and access, in English and Ukrainian. A word here
 * sends the task to the full pipeline; a false alarm ("design tokens") only costs a fuller run.
 */
const SENSITIVE =
  /\b(auth\w*|log[- ]?in|sign[- ]?in|sign[- ]?up|passwords?|oauth|sso|2fa|mfa|tokens?|api keys?|secrets?|credentials?|encrypt\w*|payments?|billing|invoices?|checkout|stripe|paddle|paypal|personal data|gdpr|pii|migrat\w*|permissions?|roles?|access control|rbac)\b|авторизац|автентифікац|парол|вхід за|вхід через|реєстрац|платіж|платеж|оплат|рахунк|персональн|міграці|шифруван|секрет|токен|прав[аи]? доступу|ролі|ролей|ролями/i;

const flag = (metadata: unknown, name: string): unknown => (metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)[name] : undefined);

/**
 * What decides without a model: the user's choice, then where the task came from and what its
 * text is about. Undefined: nothing here decides, ask the assessor. `text` is the task's title
 * and description. Pure.
 */
export function pipelineByRule(metadata: unknown, text: string): PipelineDecision | undefined {
  const chosen = flag(metadata, 'pipeline');
  if (isPipelineKind(chosen)) return { kind: chosen, by: 'user', reason: 'chosen' };

  const rule = (kind: PipelineKind, reason: PipelineReason): PipelineDecision => ({ kind, by: 'rule', reason });
  if (flag(metadata, 'architectureOnly') === true || flag(metadata, 'cloudArchitectureDesign') === true) return rule('full', 'architecture');
  const source = flag(metadata, 'sourceType');
  if (source === 'brief') return rule('full', 'brief');
  if (SENSITIVE.test(text)) return rule('full', 'sensitive');
  if (flag(metadata, 'previewQuickFix') === true) return rule('short', 'quick_fix');
  if (source === 'base-fix' || source === 'deploy') return rule('short', 'fix_main');
  return undefined;
}

/**
 * The assessor's call. It may name a pipeline (complexity_assessment.json: `pipeline`,
 * `pipeline_reason`); without one a simple task is one session and anything else the full
 * pipeline. A task it found complex is never light. Pure.
 */
export function pipelineFromAssessment(assessment: unknown): PipelineDecision {
  const complexity = flag(assessment, 'complexity');
  if (complexity !== 'simple' && complexity !== 'standard' && complexity !== 'complex') return { kind: 'full', by: 'assessor', reason: 'not_assessed' };
  const named = flag(assessment, 'pipeline');
  const detail = flag(assessment, 'pipeline_reason');
  const kind: PipelineKind = complexity === 'complex' ? 'full' : isPipelineKind(named) ? named : complexity === 'simple' ? 'single' : 'full';
  return { kind, by: 'assessor', reason: 'assessed', ...(typeof detail === 'string' && detail.trim() && isPipelineKind(named) && named === kind ? { detail: detail.trim().slice(0, 300) } : {}) };
}

/** The decision recorded on a task (its metadata), if it is one. Pure. */
export function pipelineOf(metadata: unknown): PipelineDecision | undefined {
  const decision = flag(metadata, 'pipelineDecision');
  if (!decision || typeof decision !== 'object') return undefined;
  const { kind, by, reason, detail } = decision as Record<string, unknown>;
  if (!isPipelineKind(kind)) return undefined;
  return {
    kind,
    by: by === 'user' || by === 'rule' ? by : 'assessor',
    reason: typeof reason === 'string' ? (reason as PipelineReason) : 'assessed',
    ...(typeof detail === 'string' ? { detail } : {}),
  };
}
