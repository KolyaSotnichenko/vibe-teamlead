/**
 * What the Agent Tools screen lists: the agents, the MCP servers and the categories.
 * Moved here whole from AgentTools.tsx.
 */
import { Brain, CheckCircle2, ClipboardList, Code, FileCheck, Globe, Lightbulb, ListChecks, Monitor, Search, Wrench } from 'lucide-react';

import { AVAILABLE_MODELS } from '../../../shared/constants/models';
import type { AgentSettingsSource } from '../../hooks';

// Agent configuration data - mirrors AGENT_CONFIGS from backend
// Model and thinking are now dynamically read from user settings
export interface AgentConfig {
  category: string;
  tools: string[];
  mcp_servers: string[];
  mcp_optional?: string[];
  // Maps to settings source - either a phase or a feature
  settingsSource: AgentSettingsSource;
}

// Helper to get model label from short name
export function getModelLabel(modelShort: string): string {
  const model = AVAILABLE_MODELS.find(m => m.value === modelShort);
  return model?.label.replace('Claude ', '') || modelShort;
}

export const AGENT_CONFIGS: Record<string, AgentConfig> = {
  // Spec Creation Phases - all use 'spec' phase settings
  spec_gatherer: {
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_researcher: {
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7'],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_writer: {
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_critic: {
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_discovery: {
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_context: {
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_validation: {
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },

  // Build Phases
  planner: {
    category: 'build',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'vibe-teamlead'],
    mcp_optional: ['linear'],
    settingsSource: { type: 'phase', phase: 'planning' },
  },
  coder: {
    category: 'build',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'vibe-teamlead'],
    mcp_optional: ['linear'],
    settingsSource: { type: 'phase', phase: 'coding' },
  },

  // QA Phases
  qa_reviewer: {
    category: 'qa',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'vibe-teamlead'],
    mcp_optional: ['linear', 'electron', 'puppeteer'],
    settingsSource: { type: 'phase', phase: 'qa' },
  },
  qa_fixer: {
    category: 'qa',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'vibe-teamlead'],
    mcp_optional: ['linear', 'electron', 'puppeteer'],
    settingsSource: { type: 'phase', phase: 'qa' },
  },

  // Utility Phases - use feature settings
  pr_reviewer: {
    category: 'utility',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7'],
    settingsSource: { type: 'feature', feature: 'githubPrs' },
  },
  commit_message: {
    category: 'utility',
    tools: [],
    mcp_servers: [],
    settingsSource: { type: 'feature', feature: 'utility' },
  },
  merge_resolver: {
    category: 'utility',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
    mcp_servers: [],
    settingsSource: { type: 'feature', feature: 'utility' },
  },
  insights: {
    category: 'utility',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: [],
    settingsSource: { type: 'feature', feature: 'insights' },
  },
  analysis: {
    category: 'utility',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7'],
    // Analysis uses same as insights
    settingsSource: { type: 'feature', feature: 'insights' },
  },
  batch_analysis: {
    category: 'utility',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: [],
    // Batch uses same as GitHub Issues
    settingsSource: { type: 'feature', feature: 'githubIssues' },
  },

  // Ideation & Roadmap - use feature settings
  ideation: {
    category: 'ideation',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: [],
    settingsSource: { type: 'feature', feature: 'ideation' },
  },
  roadmap_discovery: {
    category: 'ideation',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7'],
    settingsSource: { type: 'feature', feature: 'roadmap' },
  },
  pr_template_filler: {
    category: 'utility',
    tools: ['Read', 'Glob', 'Grep'],
    mcp_servers: [],
    settingsSource: { type: 'feature', feature: 'utility' },
  },
};

// MCP Server descriptions - accurate per backend models.py
export const MCP_SERVERS: Record<string, { name: string; icon: React.ElementType; tools?: string[] }> = {
  context7: {
    name: 'Context7',
    icon: Search,
    tools: ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs'],
  },
  // Built-in project memory: served by the app's own tools server, switched in Settings → Memory
  'memory': {
    name: 'Project memory',
    icon: Brain,
    tools: ['mcp__vibe-teamlead__search_memory', 'mcp__vibe-teamlead__remember'],
  },
  'vibe-teamlead': {
    name: 'Vibe Teamlead Tools',
    icon: ListChecks,
    tools: [
      'mcp__vibe-teamlead__update_subtask_status',
      'mcp__vibe-teamlead__get_build_progress',
      'mcp__vibe-teamlead__record_discovery',
      'mcp__vibe-teamlead__record_gotcha',
      'mcp__vibe-teamlead__get_session_context',
      'mcp__vibe-teamlead__update_qa_status',
    ],
  },
  linear: {
    name: 'Linear',
    icon: ClipboardList,
    tools: [
      'mcp__linear-server__list_teams',
      'mcp__linear-server__list_projects',
      'mcp__linear-server__list_issues',
      'mcp__linear-server__create_issue',
      'mcp__linear-server__update_issue',
      // ... and more
    ],
  },
  electron: {
    name: 'Electron MCP',
    icon: Monitor,
    tools: [
      'mcp__electron__get_electron_window_info',
      'mcp__electron__take_screenshot',
      'mcp__electron__send_command_to_electron',
      'mcp__electron__read_electron_logs',
    ],
  },
  puppeteer: {
    name: 'Puppeteer MCP',
    icon: Globe,
    tools: [
      'mcp__puppeteer__puppeteer_connect_active_tab',
      'mcp__puppeteer__puppeteer_navigate',
      'mcp__puppeteer__puppeteer_screenshot',
      'mcp__puppeteer__puppeteer_click',
      'mcp__puppeteer__puppeteer_fill',
      'mcp__puppeteer__puppeteer_select',
      'mcp__puppeteer__puppeteer_hover',
      'mcp__puppeteer__puppeteer_evaluate',
    ],
  },
};

// Part of the app: always there for the agents that use them (memory follows Settings → Memory)
export const BUILT_IN_SERVERS = new Set(['vibe-teamlead', 'memory']);

// All available MCP servers that can be added to agents
export const ALL_MCP_SERVERS = [
  'context7',
  'memory',
  'linear',
  'electron',
  'puppeteer',
  'vibe-teamlead'
] as const;

// Category metadata - neutral styling per design.json
export const CATEGORIES = {
  spec: { icon: FileCheck },
  build: { icon: Code },
  qa: { icon: CheckCircle2 },
  utility: { icon: Wrench },
  ideation: { icon: Lightbulb },
};
