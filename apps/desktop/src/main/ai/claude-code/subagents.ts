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
