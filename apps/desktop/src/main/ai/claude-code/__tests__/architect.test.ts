import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));

import { buildRenderScript, pngPathFor } from '../../../diagram-renderer';
import { buildQueryOptions } from '../runner';
import { createBuildToolsServer, RENDER_DIAGRAM_TOOL } from '../sdk-tools';
import { skillsForAgent } from '../skills';
import type { SessionConfig } from '../../session/types';
import type { ToolContext } from '../../tools/types';

type ToolHandler = (args: { path: string }) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;

function renderHandler(context: ToolContext): ToolHandler {
  const server = createBuildToolsServer(context, [RENDER_DIAGRAM_TOOL]);
  const registered = (server.instance as unknown as { _registeredTools: Record<string, { handler?: ToolHandler; callback?: ToolHandler }> })._registeredTools;
  const entry = registered.render_diagram;
  return (entry.handler ?? entry.callback)!;
}

describe('architect skills', () => {
  it('gets the house architecture skill and draw.io, filtered by available plugins', () => {
    expect(skillsForAgent('architect')).toEqual(['vibe-teamlead:architecture', 'drawio:drawio']);
    expect(skillsForAgent('architect', new Set(['vibe-teamlead']))).toEqual(['vibe-teamlead:architecture']);
    expect(skillsForAgent('architect', new Set())).toEqual([]);
  });

  it('loads draw.io without its cloud MCP and skips Superpowers instructions', () => {
    const config: SessionConfig = {
      agentType: 'architect',
      model: 'claude-opus-4-6',
      auth: { apiKey: 'sk-ant-test' },
      systemPrompt: 'You are the architect.',
      initialMessages: [{ role: 'user', content: 'go' }],
      toolContext: { cwd: '/work', projectDir: '/work', specDir: '/work/spec', securityProfile: undefined as never },
      maxSteps: 10,
      specDir: '/work/spec',
      projectDir: '/work',
      bundled: { drawioPluginDir: '/res/plugins/drawio', vibeSkillsDir: '/res/plugins/vibe-teamlead-skills' },
    };
    const options = buildQueryOptions(config, new AbortController(), { codegraphReady: false });
    expect(options.plugins).toContainEqual({ type: 'local', path: '/res/plugins/drawio', skipMcpDiscovery: true });
    expect(options.skills).toEqual(['vibe-teamlead:architecture', 'drawio:drawio']);
    const append = (options.systemPrompt as { append?: string }).append ?? '';
    expect(append).not.toContain('Superpowers skills');
  });
});

describe('render_diagram tool', () => {
  const root = mkdtempSync(join(tmpdir(), 'vtl-arch-'));
  const specDir = join(root, 'spec');
  mkdirSync(join(specDir, 'architecture', 'diagrams'), { recursive: true });
  const diagram = join(specDir, 'architecture', 'diagrams', 'context.drawio');
  writeFileSync(diagram, '<mxfile/>');
  const png = join(specDir, 'architecture', 'diagrams', 'context.png');
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const context = (renderDiagram: ToolContext['renderDiagram']): ToolContext =>
    ({ cwd: join(root, 'project'), projectDir: join(root, 'project'), specDir, securityProfile: undefined as never, renderDiagram }) as ToolContext;

  it('is only exposed when a renderer is available', () => {
    const server = createBuildToolsServer(context(undefined), [RENDER_DIAGRAM_TOOL]);
    const registered = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(registered.render_diagram).toBeUndefined();
  });

  it('renders a diagram in the spec directory and returns the image', async () => {
    const render = vi.fn().mockResolvedValue({ pngPath: png, width: 10, height: 5 });
    const out = await renderHandler(context(render))({ path: diagram });
    expect(render).toHaveBeenCalledWith(diagram);
    expect(out.isError).toBeFalsy();
    expect(out.content[0].type).toBe('image');
  });

  it('refuses paths outside the project, spec and allowed dirs, and non-.drawio files', async () => {
    const render = vi.fn();
    const handler = renderHandler(context(render));
    expect((await handler({ path: '/etc/passwd.drawio' })).isError).toBe(true);
    expect((await handler({ path: join(specDir, 'spec.md') })).isError).toBe(true);
    expect(render).not.toHaveBeenCalled();
  });
});

describe('diagram renderer helpers', () => {
  it('derives the PNG path next to the diagram', () => {
    expect(pngPathFor('/a/b/context.drawio')).toBe('/a/b/context.png');
    expect(pngPathFor('/a/b/c.drawio.xml')).toBe('/a/b/c.png');
  });

  it('embeds the XML safely as a string literal', () => {
    const script = buildRenderScript('<mxfile>"`${x}`</mxfile>');
    expect(script).toContain(JSON.stringify('<mxfile>"`${x}`</mxfile>'));
    expect(script).toContain("toolbar: ''");
  });
});

describe('diagram capture helpers', () => {
  it('treats a flat frame as blank and a frame with drawing as content', async () => {
    const { isBlankImage, pngPathFor, buildMermaidRenderScript } = await import('../../../diagram-renderer');
    const white = Buffer.alloc(4 * 400 * 300, 255);
    expect(isBlankImage(white)).toBe(true);
    const drawn = Buffer.from(white);
    for (let i = 0; i < drawn.length; i += 4 * 7) drawn.fill(0, i, i + 3); // dark pixels across the frame
    expect(isBlankImage(drawn)).toBe(false);
    expect(pngPathFor('/s/architecture/diagrams/ci.mmd')).toBe('/s/architecture/diagrams/ci.png');
    expect(pngPathFor('/s/architecture/diagrams/context.drawio')).toBe('/s/architecture/diagrams/context.png');
    expect(buildMermaidRenderScript('flowchart LR\n a-->b')).toContain(JSON.stringify('flowchart LR\n a-->b'));
  });
});
