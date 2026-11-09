/**
 * Which bundled Superpowers skills each agent gets.
 *
 * Vibe Teamlead's own pipeline owns orchestration (spec → plan → worktrees →
 * QA → merge), so Superpowers skills that would run a second workflow
 * (worktree management, plan execution, branch finishing, parallel dispatch)
 * stay disabled. Agents get the discipline skills: brainstorming for the spec
 * stage, TDD / debugging / verification for building and fixing.
 */

import type { AgentType } from '../config/agent-configs';

const sp = (name: string) => `superpowers:${name}`;
const vt = (name: string) => `vibe-teamlead:${name}`;

const AGENT_SKILLS: Partial<Record<AgentType, string[]>> = {
  spec_orchestrator: [sp('brainstorming')],
  spec_gatherer: [sp('brainstorming')],
  spec_discovery: [sp('brainstorming')],
  architect: [vt('architecture'), 'drawio:drawio'],
  coder: [sp('test-driven-development'), sp('systematic-debugging'), sp('verification-before-completion')],
  qa_reviewer: [sp('verification-before-completion'), sp('requesting-code-review')],
  qa_fixer: [
    sp('receiving-code-review'),
    sp('systematic-debugging'),
    sp('test-driven-development'),
    sp('verification-before-completion'),
  ],
};

/**
 * Skills for an agent, limited to plugins that are actually available.
 * @param availablePlugins plugin names present in this build (e.g. 'superpowers', 'drawio')
 */
export function skillsForAgent(agentType: AgentType, availablePlugins?: ReadonlySet<string>): string[] {
  const skills = AGENT_SKILLS[agentType] ?? [];
  if (!availablePlugins) return skills;
  return skills.filter((skill) => availablePlugins.has(skill.split(':')[0]));
}

/** Anthropic's frontend-design skill, for coder sessions that build UI. */
export const FRONTEND_DESIGN_SKILL = 'frontend-design:frontend-design';

/**
 * Skills a coder session gets on top of its usual ones, for this subtask:
 * frontend-design when the subtask touches UI files, or names no files in a
 * project that has a UI. Pure.
 */
export function subtaskSkills(
  files: string[],
  opts: { isUiFile: (file: string) => boolean; projectHasUi: boolean },
): string[] {
  const ui = files.length > 0 ? files.some(opts.isUiFile) : opts.projectHasUi;
  return ui ? [FRONTEND_DESIGN_SKILL] : [];
}

export const FRONTEND_DESIGN_INSTRUCTIONS = `
## frontend-design skill
This subtask builds UI: load the frontend-design skill (Skill tool) before writing UI code. The project's design system and the spec come first: where they set colours, type, spacing, radii or components, follow them exactly and use the skill for the rest (hierarchy, layout, copy, motion restraint, not looking templated). Don't run its plan-and-critique passes as a separate deliverable or replace the project's look; keep the TDD workflow.`;

export const SUPERPOWERS_INSTRUCTIONS = `
## Superpowers skills
Superpowers skills are available through the Skill tool; use them when they apply. They are methods, not the workflow: where a skill prescribes file locations, worktrees, branches, commits or follow-up plans, follow THIS role's instructions instead (spec files belong in the spec directory; the app manages worktrees, branches and merges).`;

/** The UX review skill (vendor/ux-review), for the QA reviewer of tasks that change UI. */
export const UX_REVIEW_SKILL = 'ux-review:ux-review';

/** Skills a QA session gets on top of its usual ones: the UX review for a reviewer of a task that changed UI. Pure. */
export function qaSkills(agentType: AgentType, taskTouchesUi: boolean | undefined): string[] {
  return agentType === 'qa_reviewer' && taskTouchesUi === true ? [UX_REVIEW_SKILL] : [];
}

export const UX_REVIEW_INSTRUCTIONS = `
## UX review
This task changed UI. After the acceptance criteria, load the ux-review skill (Skill tool) and follow it: open the pages the task changed in the browser, at 375 and 1280 pixels wide, go through them by keyboard, look at their empty, loading and error states and at how a person reaches them, and check them against its checklists. The project's design system and the spec come first. A problem that stops a person from using the page blocks approval like any other finding; matters of taste go under "UX notes" in qa_report.md.`;
