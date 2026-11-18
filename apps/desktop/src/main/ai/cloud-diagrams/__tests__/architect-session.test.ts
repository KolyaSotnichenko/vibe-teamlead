import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));

import { buildQueryOptions } from '../../claude-code/runner';
import type { SessionConfig } from '../../session/types';
import { CLOUD_DESIGN_MARKER } from '../infra-heuristic';
import {
  architectCloudDiagrams,
  cloudDiagramsInstructions,
  TERRAVISION_SERVER_KEY,
  type CloudDiagramsLaunch,
} from '../architect-session';

const launch: CloudDiagramsLaunch = {
  command: { file: '/u/uvx', args: ['--from', 'terravision[mcp]==0.56.1', 'terravision'] },
  drawFromCode: true,
};

const base = {
  launch,
  specDir: '/work/.vibe-teamlead/specs/001-x',
  sandboxHome: '/tmp/tv-home',
  platform: 'darwin' as const,
  hostEnv: { PATH: '/usr/bin', HOME: '/Users/me', AWS_SECRET_ACCESS_KEY: 's' },
};

describe('architectCloudDiagrams', () => {
  it('gives the architect TerraVision for a cloud task, writing into the spec diagrams folder', () => {
    const cloud = architectCloudDiagrams({ ...base, agentType: 'architect', text: 'Host the API on Azure App Service', terraformFiles: [] });
    expect(cloud).toBeDefined();
    expect(cloud!.outputDir).toBe('/work/.vibe-teamlead/specs/001-x/architecture/diagrams');
    expect(cloud!.server.type).toBe('stdio');
    const server = cloud!.server as { command: string; args: string[]; env: Record<string, string> };
    expect(server.command).toBe('/u/uvx');
    expect(server.args).toEqual(['--from', 'terravision[mcp]==0.56.1', 'terravision', 'mcp', '--output-dir', cloud!.outputDir]);
    expect(server.env.HOME).toBe('/tmp/tv-home');
    expect(server.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // The session's own Claude credentials are blanked for third-party servers
    expect(server.env.ANTHROPIC_API_KEY).toBe('');
  });

  it('gives nothing to an ordinary task, to another agent, or when the feature is off or not ready', () => {
    expect(architectCloudDiagrams({ ...base, agentType: 'architect', text: 'Add a dark mode toggle', terraformFiles: [] })).toBeUndefined();
    expect(architectCloudDiagrams({ ...base, agentType: 'planner', text: 'Deploy to AWS', terraformFiles: [] })).toBeUndefined();
    expect(architectCloudDiagrams({ ...base, launch: undefined, agentType: 'architect', text: 'Deploy to AWS', terraformFiles: [] })).toBeUndefined();
  });

  it('counts deployment talk when the project has Terraform, and the design task the app creates', () => {
    expect(architectCloudDiagrams({ ...base, agentType: 'architect', text: 'Add a staging environment', terraformFiles: ['infra/main.tf'] })).toBeDefined();
    expect(architectCloudDiagrams({ ...base, agentType: 'architect', text: CLOUD_DESIGN_MARKER, terraformFiles: [] })).toBeDefined();
  });
});

describe('cloudDiagramsInstructions', () => {
  it('asks for a .tvg.json design rendered next to the other diagrams, keeping them', () => {
    const text = cloudDiagramsInstructions({ outputDir: '/s/architecture/diagrams', terraformFiles: [], drawFromCode: false });
    expect(text).toContain('mcp__terravision__diagram_guide');
    expect(text).toContain('mcp__terravision__render_graph');
    expect(text).toContain('cloud-architecture');
    expect(text).toMatch(/other diagrams.*stay/i);
    expect(text).not.toContain('generate_diagram');
  });

  it("mentions drawing from the task's Terraform only when it exists and Terraform is installed", () => {
    const text = cloudDiagramsInstructions({ outputDir: '/o', terraformFiles: ['infra/main.tf'], drawFromCode: true });
    expect(text).toContain('infra/main.tf');
    expect(text).toContain('generate_diagram');
  });
});

describe('runner wiring', () => {
  const config = (extra: Partial<SessionConfig>): SessionConfig => ({
    agentType: 'architect',
    model: 'claude-opus-4-6',
    auth: { apiKey: 'sk-ant-test' },
    systemPrompt: 'You are the architect.',
    initialMessages: [{ role: 'user', content: 'go' }],
    toolContext: { cwd: '/work', projectDir: '/work', specDir: '/work/spec', securityProfile: undefined as never },
    maxSteps: 10,
    specDir: '/work/spec',
    projectDir: '/work',
    ...extra,
  });

  it('adds the TerraVision server, its prompt section, and keeps it from opening apps on the desktop', () => {
    const cloud = architectCloudDiagrams({ ...base, agentType: 'architect', text: 'Deploy to AWS', terraformFiles: [] })!;
    const options = buildQueryOptions(config({ cloudDiagrams: cloud }), new AbortController());
    expect(Object.keys(options.mcpServers ?? {})).toContain(TERRAVISION_SERVER_KEY);
    const append = (options.systemPrompt as { append?: string }).append ?? '';
    expect(append).toContain('## Cloud architecture diagram (TerraVision)');
    expect(options.disallowedTools).toContain('mcp__terravision__open_diagram_file');
  });

  it('adds nothing at all without it', () => {
    const options = buildQueryOptions(config({}), new AbortController());
    expect(Object.keys(options.mcpServers ?? {})).not.toContain(TERRAVISION_SERVER_KEY);
    expect((options.systemPrompt as { append?: string }).append ?? '').not.toContain('TerraVision');
    expect(options.disallowedTools ?? []).not.toContain('mcp__terravision__open_diagram_file');
  });

  it('ignores it for any agent but the architect', () => {
    const cloud = architectCloudDiagrams({ ...base, agentType: 'architect', text: 'Deploy to AWS', terraformFiles: [] })!;
    const options = buildQueryOptions(config({ agentType: 'coder', cloudDiagrams: cloud }), new AbortController());
    expect(Object.keys(options.mcpServers ?? {})).not.toContain(TERRAVISION_SERVER_KEY);
  });
});
