import { describe, expect, it } from 'vitest';

import { evaluatePreToolUse } from '../../claude-code/security-hooks';
import type { ToolContext } from '../../tools/types';
import { TERRAVISION_ALLOWED_TOOLS, terravisionToolDenied } from '../tool-guard';

const specDir = '/work/.vibe-teamlead/specs/001-x';
const context = { cwd: '/work', projectDir: '/work', specDir, allowedWritePaths: [specDir], agentType: 'architect', securityProfile: undefined as never } as ToolContext;
const graph = { 'azurerm_resource_group.rg': ['azurerm_linux_web_app.api'] };

describe('terravisionToolDenied', () => {
  it('allows only the guide and drawing a JSON graph', () => {
    expect(TERRAVISION_ALLOWED_TOOLS).toEqual(['diagram_guide', 'render_graph']);
    expect(terravisionToolDenied('mcp__terravision__diagram_guide', { provider: 'azure' }, context)).toBeNull();
    expect(terravisionToolDenied('mcp__terravision__render_graph', { graph, format: 'svg', outfile: 'cloud-architecture' }, context)).toBeNull();
  });

  it('refuses every tool that runs Terraform on the code, opens files or reads them', () => {
    for (const tool of ['generate_diagram', 'generate_architecture_graph', 'generate_interactive_html', 'open_diagram_file', 'diagram_file', 'anything_new']) {
      expect(terravisionToolDenied(`mcp__terravision__${tool}`, { source: '.' }, context), tool).toMatch(/not allowed/);
    }
  });

  it('refuses an output name that is a path, and any path argument', () => {
    for (const outfile of ['../escape', 'a/b', 'a\\b', '/abs/x', '..', 'C:x']) {
      expect(terravisionToolDenied('mcp__terravision__render_graph', { graph, outfile }, context), outfile).toMatch(/plain file name/);
    }
    for (const key of ['source', 'output_dir', 'path', 'annotate', 'varfile', 'planfile', 'graphfile']) {
      expect(terravisionToolDenied('mcp__terravision__render_graph', { graph, [key]: '/etc/passwd' }, context), key).toMatch(/path/);
    }
    expect(terravisionToolDenied('mcp__terravision__render_graph', { graph, format: 'html' }, context)).toMatch(/format/);
  });

  it("refuses everything when the spec's diagrams folder is not where this session may write", () => {
    const elsewhere = { ...context, allowedWritePaths: ['/other'] } as ToolContext;
    expect(terravisionToolDenied('mcp__terravision__render_graph', { graph }, elsewhere)).toMatch(/write/);
  });

  it('leaves other tools alone', () => {
    expect(terravisionToolDenied('Read', { file_path: '/x' }, context)).toBeNull();
  });
});

describe('security hooks', () => {
  it('apply the TerraVision rules to every session', () => {
    const denied = evaluatePreToolUse('mcp__terravision__generate_diagram', { source: '.' }, context) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(evaluatePreToolUse('mcp__terravision__render_graph', { graph, outfile: 'cloud-architecture' }, context)).toEqual({});
  });
});
