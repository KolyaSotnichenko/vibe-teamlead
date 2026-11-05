import { describe, it, expect } from 'vitest';

import {
  AGENT_CONFIGS,
  getAgentConfig,
  getDefaultThinkingLevel,
  getRequiredMcpServers,
  mapMcpServerName,
  CONTEXT7_TOOLS,
  LINEAR_TOOLS,
  MEMORY_MCP_TOOLS, GRAPHITI_MCP_TOOLS,
  PLAYWRIGHT_TOOLS,
  ELECTRON_TOOLS,
  type AgentType,
} from '../agent-configs';

// =============================================================================
// All Agent Types (26 total)
// =============================================================================

const ALL_AGENT_TYPES: AgentType[] = [
  'spec_gatherer',
  'spec_researcher',
  'spec_writer',
  'spec_critic',
  'spec_discovery',
  'spec_context',
  'spec_validation',
  'spec_compaction',
  'planner',
  'coder',
  'qa_reviewer',
  'qa_fixer',
  'insights',
  'merge_resolver',
  'commit_message',
  'pr_template_filler',
  'pr_reviewer',
  'pr_orchestrator_parallel',
  'pr_followup_parallel',
  'pr_followup_extraction',
  'pr_finding_validator',
  'analysis',
  'batch_analysis',
  'batch_validation',
  'roadmap_discovery',
  'competitor_analysis',
  'ideation',
];

describe('AGENT_CONFIGS', () => {
  it('should have all expected agent types configured', () => {
    expect(Object.keys(AGENT_CONFIGS).length).toBeGreaterThanOrEqual(26);
  });

  it('should contain all expected agent types', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      expect(AGENT_CONFIGS).toHaveProperty(agentType);
    }
  });

  it('should have valid thinking defaults for all agents', () => {
    const validLevels = new Set(['low', 'medium', 'high']);
    for (const [type, config] of Object.entries(AGENT_CONFIGS)) {
      expect(validLevels.has(config.thinkingDefault)).toBe(true);
    }
  });

  it('should have tools as arrays for all agents', () => {
    for (const config of Object.values(AGENT_CONFIGS)) {
      expect(Array.isArray(config.tools)).toBe(true);
      expect(Array.isArray(config.mcpServers)).toBe(true);
      expect(Array.isArray(config.appTools)).toBe(true);
    }
  });

  // Spot-check specific agent configs match Python AGENT_CONFIGS
  it('should configure coder with read+write+web tools', () => {
    const config = AGENT_CONFIGS.coder;
    expect(config.tools).toContain('Read');
    expect(config.tools).toContain('Write');
    expect(config.tools).toContain('Edit');
    expect(config.tools).toContain('Bash');
    expect(config.tools).toContain('WebFetch');
    expect(config.tools).toContain('Glob');
    expect(config.tools).toContain('Grep');
    expect(config.thinkingDefault).toBe('low');
  });

  it('should configure planner with memory and app MCP tools', () => {
    const config = AGENT_CONFIGS.planner;
    expect(config.mcpServers).toContain('context7');
    expect(config.mcpServers).toContain('memory');
    expect(config.mcpServers).toContain('vibe-teamlead');
    expect(config.mcpServersOptional).toContain('linear');
    expect(config.thinkingDefault).toBe('high');
  });

  it('should configure qa_reviewer with browser MCP', () => {
    const config = AGENT_CONFIGS.qa_reviewer;
    expect(config.mcpServers).toContain('browser');
    expect(config.thinkingDefault).toBe('high');
  });

  it('should configure spec_critic with spec tools (no Edit/Bash) and context7', () => {
    const config = AGENT_CONFIGS.spec_critic;
    expect(config.tools).toContain('Read');
    expect(config.tools).toContain('Write');
    expect(config.tools).not.toContain('Edit');
    expect(config.tools).not.toContain('Bash');
    expect(config.tools).toContain('WebFetch');
    expect(config.mcpServers).toContain('context7');
  });

  it('should configure merge_resolver with no tools', () => {
    const config = AGENT_CONFIGS.merge_resolver;
    expect(config.tools).toHaveLength(0);
    expect(config.mcpServers).toHaveLength(0);
  });

  it('should only give SpawnSubagent to orchestrator agent types', () => {
    const orchestratorTypes: AgentType[] = ['spec_orchestrator', 'build_orchestrator'];
    const nonOrchestratorTypes = Object.keys(AGENT_CONFIGS).filter(
      t => !orchestratorTypes.includes(t as AgentType)
    ) as AgentType[];

    // Orchestrators should have SpawnSubagent
    for (const type of orchestratorTypes) {
      expect(AGENT_CONFIGS[type].tools).toContain('SpawnSubagent');
    }

    // Non-orchestrators should NOT have SpawnSubagent
    for (const type of nonOrchestratorTypes) {
      expect(AGENT_CONFIGS[type].tools).not.toContain('SpawnSubagent');
    }
  });
});

describe('MCP tool arrays', () => {
  it('CONTEXT7_TOOLS should have 2 tools', () => {
    expect(CONTEXT7_TOOLS).toHaveLength(2);
    expect(CONTEXT7_TOOLS).toContain('mcp__context7__resolve-library-id');
  });

  it('LINEAR_TOOLS should have 16 tools', () => {
    expect(LINEAR_TOOLS).toHaveLength(16);
  });

  it('MEMORY_MCP_TOOLS should have 5 tools', () => {
    expect(MEMORY_MCP_TOOLS).toHaveLength(5);
  });

  it('PLAYWRIGHT_TOOLS should be Playwright MCP tools', () => {
    expect(PLAYWRIGHT_TOOLS.every((t) => t.startsWith('mcp__playwright__browser_'))).toBe(true);
  });

  it('ELECTRON_TOOLS should have 4 tools', () => {
    expect(ELECTRON_TOOLS).toHaveLength(4);
  });
});

describe('getAgentConfig', () => {
  it('should return config for valid agent types', () => {
    const config = getAgentConfig('coder');
    expect(config).toBeDefined();
    expect(config.tools).toBeDefined();
    expect(config.mcpServers).toBeDefined();
  });

  it('should throw for unknown agent type', () => {
    expect(() => getAgentConfig('unknown_agent' as AgentType)).toThrow(
      /Unknown agent type/,
    );
  });
});

describe('getDefaultThinkingLevel', () => {
  it.each([
    ['coder', 'low'],
    ['planner', 'high'],
    ['qa_reviewer', 'high'],
    ['qa_fixer', 'medium'],
    ['spec_gatherer', 'medium'],
    ['ideation', 'high'],
    ['insights', 'low'],
  ] as [AgentType, string][])(
    'should return %s thinking level for %s',
    (agentType, expected) => {
      expect(getDefaultThinkingLevel(agentType)).toBe(expected);
    },
  );
});

describe('mapMcpServerName', () => {
  it('should map known server names', () => {
    expect(mapMcpServerName('context7')).toBe('context7');
    expect(mapMcpServerName('graphiti')).toBe('memory');
    expect(mapMcpServerName('graphiti-memory')).toBe('memory');
    expect(mapMcpServerName('linear')).toBe('linear');
    expect(mapMcpServerName('vibe-teamlead')).toBe('vibe-teamlead');
  });

  it('should return null for unknown names', () => {
    expect(mapMcpServerName('unknown')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(mapMcpServerName('')).toBeNull();
  });

  it('should be case-insensitive', () => {
    expect(mapMcpServerName('Context7')).toBe('context7');
    expect(mapMcpServerName('GRAPHITI')).toBe('memory');
  });

  it('should accept custom server IDs', () => {
    expect(mapMcpServerName('my-custom-server', ['my-custom-server'])).toBe(
      'my-custom-server',
    );
  });
});

describe('getRequiredMcpServers', () => {
  it('should return base MCP servers for an agent', () => {
    const servers = getRequiredMcpServers('spec_researcher');
    expect(servers).toContain('context7');
  });

  it('should return empty array for agents with no MCP', () => {
    const servers = getRequiredMcpServers('merge_resolver');
    expect(servers).toEqual([]);
  });

  it('should filter memory when not enabled', () => {
    const servers = getRequiredMcpServers('coder', { memoryEnabled: false });
    expect(servers).not.toContain('memory');
  });

  it('should include memory when enabled', () => {
    const servers = getRequiredMcpServers('coder', { memoryEnabled: true });
    expect(servers).toContain('memory');
  });

  it('should add linear when optional and enabled', () => {
    const servers = getRequiredMcpServers('planner', {
      linearEnabled: true,
      memoryEnabled: true,
    });
    expect(servers).toContain('linear');
  });

  it('should not add linear when not enabled', () => {
    const servers = getRequiredMcpServers('planner', {
      linearEnabled: false,
      memoryEnabled: true,
    });
    expect(servers).not.toContain('linear');
  });

  it('should resolve browser to electron for electron projects', () => {
    const servers = getRequiredMcpServers('qa_reviewer', {
      memoryEnabled: true,
      projectCapabilities: { is_electron: true },
      electronMcpEnabled: true,
    });
    expect(servers).not.toContain('browser');
    expect(servers).toContain('electron');
  });

  it('should resolve browser to playwright for web frontend projects', () => {
    const servers = getRequiredMcpServers('qa_reviewer', {
      memoryEnabled: true,
      projectCapabilities: { is_web_frontend: true, is_electron: false },
    });
    expect(servers).not.toContain('browser');
    expect(servers).toContain('playwright');
    expect(servers).not.toContain('chrome-devtools');
  });

  it('should give the QA fixer Chrome DevTools too, and honour the opt-out', () => {
    const caps = { is_web_frontend: true, is_electron: false };
    expect(getRequiredMcpServers('qa_fixer', { projectCapabilities: caps })).toEqual(
      expect.arrayContaining(['playwright', 'chrome-devtools']),
    );
    const off = getRequiredMcpServers('qa_fixer', { projectCapabilities: caps, browserMcpEnabled: false });
    expect(off).not.toContain('playwright');
    expect(off).not.toContain('chrome-devtools');
  });

  it('drops the browser servers for QA when the task changed no UI file, and keeps them when unknown', () => {
    const web = { is_web_frontend: true, is_electron: false };
    for (const agent of ['qa_reviewer', 'qa_fixer'] as const) {
      const off = getRequiredMcpServers(agent, { projectCapabilities: web, taskTouchesUi: false });
      expect(off).not.toContain('playwright');
      expect(off).not.toContain('chrome-devtools');
      expect(off).not.toContain('browser');
      expect(off).toContain('vibe-teamlead');
      expect(getRequiredMcpServers(agent, { projectCapabilities: web, taskTouchesUi: true })).toContain('playwright');
      expect(getRequiredMcpServers(agent, { projectCapabilities: web })).toContain('playwright');
    }
    const electron = getRequiredMcpServers('qa_reviewer', { projectCapabilities: { is_electron: true }, electronMcpEnabled: true, taskTouchesUi: false });
    expect(electron).not.toContain('electron');
  });

  it('should filter context7 when explicitly disabled', () => {
    const servers = getRequiredMcpServers('spec_researcher', {
      context7Enabled: false,
    });
    expect(servers).not.toContain('context7');
  });

  it('should support per-agent MCP additions', () => {
    const servers = getRequiredMcpServers('insights', {
      agentMcpAdd: 'context7',
    });
    expect(servers).toContain('context7');
  });

  it('should support per-agent MCP removals but never remove the app tools', () => {
    const servers = getRequiredMcpServers('coder', {
      memoryEnabled: true,
      agentMcpRemove: 'auto-claude,memory',
    });
    expect(servers).toContain('vibe-teamlead');
    expect(servers).not.toContain('memory');
  });
});
