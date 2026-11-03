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

const AGENT_SKILLS: Partial<Record<AgentType, string[]>> = {
  spec_orchestrator: [sp('brainstorming')],
  spec_gatherer: [sp('brainstorming')],
  spec_discovery: [sp('brainstorming')],
  coder: [sp('test-driven-development'), sp('systematic-debugging'), sp('verification-before-completion')],
  qa_reviewer: [sp('verification-before-completion'), sp('requesting-code-review')],
  qa_fixer: [
    sp('receiving-code-review'),
    sp('systematic-debugging'),
    sp('test-driven-development'),
    sp('verification-before-completion'),
  ],
};

export function skillsForAgent(agentType: AgentType): string[] {
  return AGENT_SKILLS[agentType] ?? [];
}

export const SUPERPOWERS_INSTRUCTIONS = `
## Superpowers skills
Superpowers skills are available through the Skill tool; use them when they apply. They are methods, not the workflow: where a skill prescribes file locations, worktrees, branches, commits or follow-up plans, follow THIS role's instructions instead (spec files belong in the spec directory; the app manages worktrees, branches and merges).`;
