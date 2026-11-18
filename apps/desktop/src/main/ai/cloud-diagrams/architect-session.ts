/**
 * The architect's design moment: for a task about cloud infrastructure, with the
 * setting on and the tools installed, the architect gets TerraVision's MCP server
 * (writing into the spec's diagrams folder) and a short prompt section. Any other
 * task, or any other agent, gets nothing: no server, no prompt text, no tokens.
 * Pure; no Electron: the worker uses it.
 */

import { join } from 'node:path';

import type { McpServerConfig as SdkMcpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import { CREDENTIAL_BLANKING_ENV } from '../claude-code/mcp-servers';
import { concernsCloudInfra } from './infra-heuristic';
import { cloudSafeEnv } from './terravision';

/** Tool prefix inside Claude Code: mcp__terravision__<tool> */
export const TERRAVISION_SERVER_KEY = 'terravision';

/** TerraVision tools the architect must not call: this one opens files in the user's desktop apps. */
export const TERRAVISION_DISALLOWED_TOOLS = [`mcp__${TERRAVISION_SERVER_KEY}__open_diagram_file`];

/** Resolved in the main process: undefined when the setting is off or TerraVision can't run. */
export interface CloudDiagramsLaunch {
  /** TerraVision with its MCP extra (terravisionCommand(…, true)) */
  command: { file: string; args: string[] };
  /** Terraform or OpenTofu is installed */
  drawFromCode: boolean;
}

/** What one architect session gets (SessionConfig.cloudDiagrams). */
export interface ArchitectCloudDiagrams {
  server: SdkMcpServerConfig;
  outputDir: string;
  terraformFiles: string[];
  drawFromCode: boolean;
}

export function architectCloudDiagrams(input: {
  agentType: string;
  launch: CloudDiagramsLaunch | undefined;
  specDir: string;
  /** The spec, requirements and task description */
  text: string;
  terraformFiles: string[];
  sandboxHome: string;
  platform: 'darwin' | 'win32' | 'linux';
  hostEnv: NodeJS.ProcessEnv;
}): ArchitectCloudDiagrams | undefined {
  const { agentType, launch, specDir, text, terraformFiles } = input;
  if (agentType !== 'architect' || !launch) return undefined;
  if (!concernsCloudInfra({ text, projectHasTerraform: terraformFiles.length > 0 })) return undefined;
  const outputDir = join(specDir, 'architecture', 'diagrams');
  const env = cloudSafeEnv(input.hostEnv, { platform: input.platform, sandboxHome: input.sandboxHome });
  const serverEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) serverEnv[name] = value;
  return {
    server: {
      type: 'stdio',
      command: launch.command.file,
      args: [...launch.command.args, 'mcp', '--output-dir', outputDir],
      env: { ...serverEnv, ...CREDENTIAL_BLANKING_ENV },
    },
    outputDir,
    terraformFiles,
    drawFromCode: launch.drawFromCode,
  };
}

/** The architect's prompt section, added by the runner only when the server is there. */
export function cloudDiagramsInstructions(cloud: { outputDir: string; terraformFiles: string[]; drawFromCode: boolean }): string {
  const t = `mcp__${TERRAVISION_SERVER_KEY}__`;
  const fromCode = cloud.terraformFiles.length > 0 && cloud.drawFromCode
    ? `\nThe project already has Terraform (${cloud.terraformFiles.slice(0, 5).join(', ')}${cloud.terraformFiles.length > 5 ? ', …' : ''}). Base the graph on it, changed as this task requires. \`${t}generate_diagram\` draws the current code (it runs \`terraform init\` and \`plan\` without cloud credentials); if it fails for want of credentials or variables, draw from the graph instead and say so.`
    : '';
  return `
## Cloud architecture diagram (TerraVision)
This task concerns cloud infrastructure, so you also draw the target cloud architecture with TerraVision (official AWS, Azure and Google Cloud icons). Your other diagrams, ADRs and architecture.md stay exactly as the architecture skill asks; this is one more diagram.
1. Call \`${t}diagram_guide\` once with the provider ("aws", "azure" or "gcp": the cloud the spec and the project point at; one provider per diagram).
2. Write the target architecture as a graph: \`<resource_type>.<name>\` → what it connects to or contains, where the API and web run, the database, storage, sign-in, monitoring and networking.
3. Call \`${t}render_graph\` with that graph, \`outfile: "cloud-architecture"\` and \`format: "svg"\`. It saves SVG, PNG, draw.io and the graph as \`.tvg.json\` in ${cloud.outputDir}, next to your other diagrams. Look at the result and fix what reads badly.${fromCode}
Reference the diagram in architecture.md. Don't call \`${t}open_diagram_file\`.`;
}
