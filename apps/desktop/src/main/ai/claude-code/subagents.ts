/**
 * Specialist subagents for orchestrator sessions.
 *
 * Replaces the old SpawnSubagent tool: each specialist is registered as a
 * Claude Code subagent (AgentDefinition) and the orchestrator delegates to it
 * with the built-in Agent tool (`subagent_type: "<name>"`).
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import { getAgentConfig, type AgentType } from '../config/agent-configs';
import { resolveBuiltinTools } from './runner';

interface SpecialistSpec {
  agentType: AgentType;
  promptName: string;
  description: string;
}

/** Specialists available to the agentic spec orchestrator */
export const SPEC_SPECIALISTS: Record<string, SpecialistSpec> = {
  complexity_assessor: {
    agentType: 'spec_gatherer',
    promptName: 'complexity_assessor',
    description: 'Assesses task complexity (simple/standard/complex) and returns JSON.',
  },
  spec_discovery: {
    agentType: 'spec_discovery',
    promptName: 'spec_gatherer',
    description: 'Analyzes project structure, tech stack and conventions; writes context.json.',
  },
  spec_gatherer: {
    agentType: 'spec_gatherer',
    promptName: 'spec_gatherer',
    description: 'Gathers and validates requirements from the task; writes requirements.json.',
  },
  spec_researcher: {
    agentType: 'spec_researcher',
    promptName: 'spec_researcher',
    description: 'Researches approaches, external APIs and libraries; writes research.json.',
  },
  spec_writer: {
    agentType: 'spec_writer',
    promptName: 'spec_writer',
    description: 'Writes spec.md and implementation_plan.json.',
  },
  spec_critic: {
    agentType: 'spec_critic',
    promptName: 'spec_critic',
    description: 'Reviews the spec for completeness, feasibility and gaps.',
  },
  spec_validation: {
    agentType: 'spec_validation',
    promptName: 'spec_writer',
    description: 'Final validation of spec.md and implementation_plan.json.',
  },
};

/**
 * Build Claude Code subagent definitions.
 *
 * @param specialists - Which specialists to register
 * @param loadPrompt - Loads an assembled system prompt by name
 */
export async function buildSubagents(
  specialists: Record<string, SpecialistSpec>,
  loadPrompt: (promptName: string) => Promise<string>,
): Promise<Record<string, AgentDefinition>> {
  const agents: Record<string, AgentDefinition> = {};
  for (const [name, spec] of Object.entries(specialists)) {
    const tools = resolveBuiltinTools(getAgentConfig(spec.agentType).tools, false).filter(
      (tool) => tool !== 'Agent',
    );
    agents[name] = {
      description: spec.description,
      prompt: await loadPrompt(spec.promptName),
      tools,
    };
  }
  return agents;
}

// =============================================================================
// Helper subagents for the planner, coder and QA
// =============================================================================

/** Settings → Agents → Subagents */
export interface SubagentSettings {
  enabled: boolean;
  /** Model of the helpers; empty = the agent's own model */
  model: string;
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = { enabled: true, model: '' };

type HelperName = 'explorer' | 'test_runner' | 'reviewer';

interface HelperSpec {
  description: string;
  /** Tools taken away; everything else (MCP servers such as CodeGraph and Context7, skills, web) is inherited */
  disallowedTools: string[];
  prompt: string;
}

/** No helper changes files or the build's state */
const NO_CHANGES = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'mcp__vibe-teamlead__update_subtask_status',
  'mcp__vibe-teamlead__update_qa_status',
  'mcp__vibe-teamlead__record_discovery',
  'mcp__vibe-teamlead__record_gotcha',
  'mcp__vibe-teamlead__remember',
];

const REPORT_RULES = `Report back in under 300 words: findings first, then file paths with line numbers. No preamble. You run inside an isolated task worktree; stay in it.`;

/**
 * The helpers. They inherit the session's tools (CodeGraph, Context7, project
 * memory search, skills from Superpowers, web) minus anything that changes
 * files; the explorer has no shell either. The session's hooks (command
 * allowlist, path containment) apply to them too.
 */
export const HELPER_SUBAGENTS: Record<HelperName, HelperSpec> = {
  explorer: {
    description:
      'Read-only codebase search. Use it to find where something is defined or used, how a module works, or which files a change touches, instead of reading many files yourself.',
    disallowedTools: [...NO_CHANGES, 'Bash'],
    prompt: `You are a codebase explorer. Answer the question you are given by searching and reading the code: CodeGraph first when it is available, then Glob, Grep and Read. Do not change anything. ${REPORT_RULES}`,
  },
  test_runner: {
    description:
      'Runs test, lint, typecheck or build commands and reports only what failed (test name, file:line, error). Use it for long test runs so their output stays out of your context.',
    disallowedTools: NO_CHANGES,
    prompt: `You are a test runner. Run exactly the commands you are given (or the project's test command if none), then report: pass/fail counts and, for each failure, the test name, file:line and the essential error lines. Do not edit files or try to fix anything. ${REPORT_RULES}`,
  },
  reviewer: {
    description:
      'Reviews the current changes (git diff) against the subtask or acceptance criteria and reports concrete problems: bugs, missed criteria, missing tests. Use it before marking work complete.',
    disallowedTools: NO_CHANGES,
    prompt: `You are a code reviewer. Inspect the changes with \`git diff\` and \`git status\` (read-only git only) and the files they touch. Check them against what you were asked to verify. Report only real problems, most severe first, each with file:line and why it is wrong. If there are none, say so. Do not edit files. ${REPORT_RULES}`,
  },
};

/** Which helpers each pipeline agent gets. */
const HELPERS_BY_AGENT: Partial<Record<AgentType, HelperName[]>> = {
  planner: ['explorer'],
  coder: ['explorer', 'test_runner', 'reviewer'],
  qa_reviewer: ['explorer', 'test_runner'],
  qa_fixer: ['explorer', 'test_runner', 'reviewer'],
};

/** Helper subagents for one session, or none when they are off or the agent has none. */
export function helperSubagents(agentType: AgentType, settings: SubagentSettings | undefined): Record<string, AgentDefinition> {
  const s = settings ?? DEFAULT_SUBAGENT_SETTINGS;
  if (!s.enabled) return {};
  const agents: Record<string, AgentDefinition> = {};
  for (const name of HELPERS_BY_AGENT[agentType] ?? []) {
    const spec = HELPER_SUBAGENTS[name];
    agents[name] = {
      description: spec.description,
      prompt: spec.prompt,
      disallowedTools: spec.disallowedTools,
      model: s.model || 'inherit',
    };
  }
  return agents;
}

/** Tells the agent which helpers it has and when to use them. Empty when it has none. */
export function helpersPromptSection(agents: Record<string, AgentDefinition>): string {
  const names = Object.keys(agents);
  if (names.length === 0) return '';
  const lines = names.map((n) => `- \`${n}\`: ${agents[n].description}`);
  return [
    '## HELPER SUBAGENTS',
    '',
    'You can delegate to these subagents with the Agent tool (`subagent_type`). Each runs in its own context and returns a short report, which keeps your context for the actual work. Give each one a precise, self-contained instruction.',
    '',
    ...lines,
    '',
    'Delegate searches across many files, long test runs and the final self-review. Do the edits yourself: these helpers never change files.',
    '',
    'You can also start your own subagent for a self-contained piece of work (researching a library, investigating a failure, writing tests for a separate module): call the Agent tool without `subagent_type` and write its instructions yourself. Such a subagent can edit files, so give it files no other subagent touches, and check its work before you build on it.',
    '',
    'Run subagents in the foreground (`run_in_background: false`); for independent ones, put several Agent calls in one message so they run in parallel.',
  ].join('\n');
}
