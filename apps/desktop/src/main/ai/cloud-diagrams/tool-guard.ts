/**
 * What the architect may do with TerraVision's MCP server (a PreToolUse rule in
 * security-hooks.ts). The server runs outside the app's hooks, so its arguments are
 * checked here: only the guide and drawing a JSON graph are allowed. The tools that
 * run `terraform init/plan` on the repository's code (generate_diagram,
 * generate_architecture_graph, generate_interactive_html), open files on the desktop
 * or read them are refused: drawing from code is the app's own after-merge step,
 * with no model. Files go only to the server's fixed output folder, the spec's
 * diagrams folder, under a plain file name. Pure; no Electron.
 */

import { join } from 'node:path';

import { isPathContained } from '../security/path-containment';
import type { ToolContext } from '../tools/types';

const PREFIX = 'mcp__terravision__';

export const TERRAVISION_ALLOWED_TOOLS = ['diagram_guide', 'render_graph'] as const;

/** Every other tool TerraVision 0.56.1 serves, for the session's disallowedTools. */
export const TERRAVISION_DISALLOWED_TOOLS = [
  'generate_diagram',
  'generate_architecture_graph',
  'generate_interactive_html',
  'open_diagram_file',
  'diagram_file',
].map((name) => `${PREFIX}${name}`);

/** Arguments that name a file or folder: none is accepted. */
const PATH_ARGS = ['source', 'path', 'output_dir', 'outdir', 'annotate', 'varfile', 'planfile', 'graphfile', 'file', 'dir'];
const FORMATS = new Set(['png', 'svg', 'pdf', 'dot', 'drawio']);
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The reason to refuse, or null. Null for any tool that is not TerraVision's. */
export function terravisionToolDenied(toolName: string, toolInput: Record<string, unknown> | null, context: ToolContext): string | null {
  if (!toolName.startsWith(PREFIX)) return null;
  const tool = toolName.slice(PREFIX.length);
  if (!(TERRAVISION_ALLOWED_TOOLS as readonly string[]).includes(tool)) {
    return `${toolName} is not allowed: only diagram_guide and render_graph (a JSON graph). Drawing from the Terraform code is done by the app after merges.`;
  }
  const diagrams = join(context.specDir, 'architecture', 'diagrams');
  const roots = context.allowedWritePaths?.length ? context.allowedWritePaths : [context.cwd, context.specDir];
  if (!roots.some((root) => isPathContained(diagrams, root).contained)) {
    return `TerraVision may not write here: ${diagrams} is outside the folders this session may write to.`;
  }
  for (const key of PATH_ARGS) {
    if (toolInput && toolInput[key] !== undefined && toolInput[key] !== null && toolInput[key] !== '') {
      return `TerraVision's "${key}" argument names a path, which is not allowed here. Pass the graph itself to render_graph.`;
    }
  }
  if (tool === 'render_graph') {
    const outfile = toolInput?.outfile;
    if (outfile !== undefined && (typeof outfile !== 'string' || !PLAIN_NAME.test(outfile) || outfile.includes('..'))) {
      return 'render_graph\'s outfile must be a plain file name without folders or "..", e.g. "cloud-architecture".';
    }
    const format = toolInput?.format;
    if (format !== undefined && (typeof format !== 'string' || !FORMATS.has(format.toLowerCase()))) {
      return 'render_graph\'s format must be one of png, svg, pdf, dot, drawio.';
    }
  }
  return null;
}
