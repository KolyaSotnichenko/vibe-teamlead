/**
 * What each pipeline agent starts with, as far as the app controls it: the role prompt and what
 * the app injects into it (design system, QA tools, helpers), the sections the runner appends,
 * the skill listing and the MCP tools. Tokens are estimated as characters / 4; the Claude Code
 * preset (its own system prompt and built-in tool definitions) and the conversation are not
 * counted. No model calls.
 *
 * As a test it guards the budget. As a measurement: `CONTEXT_BUDGET_OUT=<file.md>
 * [CONTEXT_BUDGET_PROJECT=<project dir>] npx vitest run context-budget` writes the table, using
 * that project's design system (default: the app's own, as a sample). CONTEXT_BUDGET_BEFORE=1
 * measures the designer and non-UI QA rows as they were before the 2026-11-17 cuts.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

// The browser servers are counted from their measured tool lists, not started
vi.mock('../browser-servers', () => ({ removeBrokenBrowserServers: (servers: unknown) => servers }));

import { buildQueryOptions } from '../runner';
import { helperSubagents, helpersPromptSection } from '../subagents';
import { designerSkills, FRONTEND_DESIGN_SKILL, GSAP_SKILLS, qaSkills, subtaskSkills } from '../skills';
import { designPromptSection, loadDesignSystem } from '../../design/design-system';
import { designPointer } from '../../design/design-scope';
import { getQaToolsSection } from '../../prompts/prompt-loader';
import type { AgentType } from '../../config/agent-configs';
import type { SessionConfig } from '../../session/types';
import type { ToolContext } from '../../tools/types';

const APP = resolve(__dirname, '../../../../..');
const VENDOR = join(APP, 'vendor');
const tokens = (chars: number) => Math.ceil(chars / 4);

/** Tool definitions of the external MCP servers, measured with tools/list (2026-11-17, bundled versions) */
const EXTERNAL_MCP: Record<string, { tools: number; chars: number }> = {
  playwright: { tools: 30, chars: 20_291 },
  'chrome-devtools': { tools: 32, chars: 27_441 },
  codegraph: { tools: 1, chars: 1_582 },
  // Hosted (not measured here): two tools with long descriptions
  context7: { tools: 2, chars: 4_000 },
};

const scratch = mkdtempSync(join(tmpdir(), 'vtl-budget-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function sampleProject(): string {
  const given = process.env.CONTEXT_BUDGET_PROJECT;
  if (given) return given;
  const dir = join(scratch, 'project');
  mkdirSync(join(dir, '.vibe-teamlead'), { recursive: true });
  copyFileSync(join(APP, 'design', 'DESIGN-SYSTEM.md'), join(dir, '.vibe-teamlead', 'design-system.md'));
  return dir;
}

const project = sampleProject();
const specDir = join(project, '.vibe-teamlead', 'specs', '001-sample');
const designSystem = loadDesignSystem(project, undefined);
const webUi = { is_web_frontend: true };

const bundled = {
  superpowersDir: join(VENDOR, 'superpowers'),
  vibeSkillsDir: join(VENDOR, 'vibe-teamlead-skills'),
  drawioPluginDir: join(VENDOR, 'drawio'),
  frontendDesignDir: join(VENDOR, 'frontend-design'),
  uxReviewDir: join(VENDOR, 'ux-review'),
  gsapSkillsDir: join(VENDOR, 'gsap-skills'),
  playwrightMcpCli: '/bundled/playwright-mcp/cli.js',
  chromeDevtoolsMcpCli: '/bundled/chrome-devtools-mcp/cli.js',
  nodeRuntime: '/bundled/node',
  codegraphBin: '/bundled/codegraph',
};

const PLUGIN_DIRS: Record<string, string> = {
  superpowers: 'superpowers',
  'vibe-teamlead': 'vibe-teamlead-skills',
  drawio: 'drawio',
  'frontend-design': 'frontend-design',
  'ux-review': 'ux-review',
  'gsap-skills': 'gsap-skills',
};

/** The skill's listing entry: its name and the description from SKILL.md's front matter */
function listingChars(skill: string): number {
  const [plugin, name] = skill.split(':');
  try {
    const text = readFileSync(join(VENDOR, PLUGIN_DIRS[plugin], 'skills', name, 'SKILL.md'), 'utf-8');
    const description = /^description:\s*(.*)$/m.exec(text)?.[1] ?? '';
    return skill.length + description.length + 10;
  } catch {
    return skill.length + 200;
  }
}

function rolePrompt(name: string): string {
  try {
    return readFileSync(join(APP, 'prompts', `${name}.md`), 'utf-8');
  } catch {
    return '';
  }
}

interface Case {
  label: string;
  agentType: AgentType;
  prompt: string;
  design?: 'builder' | 'qa' | 'pointer';
  extraSkills?: string[];
  skillsOverride?: string[];
  taskTouchesUi?: boolean;
}

const CASES: Case[] = [
  { label: 'spec_gatherer', agentType: 'spec_gatherer', prompt: 'spec_gatherer' },
  { label: 'spec_researcher', agentType: 'spec_researcher', prompt: 'spec_researcher' },
  { label: 'spec_writer', agentType: 'spec_writer', prompt: 'spec_writer', design: 'builder' },
  { label: 'spec_critic', agentType: 'spec_critic', prompt: 'spec_critic', design: 'builder' },
  { label: 'architect', agentType: 'architect', prompt: 'architect', design: 'builder' },
  { label: 'planner', agentType: 'planner', prompt: 'planner', design: 'builder' },
  { label: 'designer (no GSAP in project)', agentType: 'designer', prompt: 'designer', design: 'builder', skillsOverride: [], extraSkills: process.env.CONTEXT_BUDGET_BEFORE ? [FRONTEND_DESIGN_SKILL, ...GSAP_SKILLS] : designerSkills(false) },
  { label: 'coder, non-UI subtask', agentType: 'coder', prompt: 'coder', design: 'pointer', extraSkills: subtaskSkills(['src/api/x.ts'], { isUiFile: (f) => f.endsWith('.tsx'), projectHasUi: true }) },
  { label: 'coder, UI subtask', agentType: 'coder', prompt: 'coder', design: 'builder', extraSkills: subtaskSkills(['src/App.tsx'], { isUiFile: (f) => f.endsWith('.tsx'), projectHasUi: true }) },
  { label: 'qa_reviewer, UI task', agentType: 'qa_reviewer', prompt: 'qa_reviewer', design: 'qa', extraSkills: qaSkills('qa_reviewer', true), taskTouchesUi: true },
  { label: 'qa_fixer, UI task', agentType: 'qa_fixer', prompt: 'qa_fixer', design: 'builder', taskTouchesUi: true },
  { label: 'qa_reviewer, non-UI task', agentType: 'qa_reviewer', prompt: 'qa_reviewer', design: process.env.CONTEXT_BUDGET_BEFORE ? 'qa' : 'pointer', taskTouchesUi: false },
  { label: 'qa_fixer, non-UI task', agentType: 'qa_fixer', prompt: 'qa_fixer', design: process.env.CONTEXT_BUDGET_BEFORE ? 'builder' : 'pointer', taskTouchesUi: false },
  { label: 'deploy_readiness', agentType: 'deploy_readiness', prompt: 'deploy_readiness' },
];

interface Row {
  label: string;
  role: number;
  injected: number;
  appended: number;
  skills: number;
  /** Sent in full: the sessions have no ToolSearch tool, so Claude Code never defers MCP tools (measured on 2.1.317) */
  mcpFull: number;
  mcpServers: string[];
  skillNames: string[];
}

function measure(c: Case): Row {
  const toolContext: ToolContext = { cwd: project, projectDir: project, specDir, securityProfile: undefined as never };
  const helpers = helperSubagents(c.agentType, undefined);
  const design =
    c.design === 'pointer'
      ? designPointer(c.agentType, designSystem.markdownPath)
      : c.design
        ? designPromptSection(designSystem, { role: c.design, storybookEnabled: false, storybook: designSystem.storybook })
        : '';
  const qaTools = c.agentType === 'qa_reviewer' || c.agentType === 'qa_fixer' ? getQaToolsSection(webUi as never, { taskTouchesUi: process.env.CONTEXT_BUDGET_BEFORE ? undefined : c.taskTouchesUi }) : '';
  const injected = [design, qaTools, helpersPromptSection(helpers), `## SPEC LOCATION\n\n- Spec: \`${specDir}/spec.md\`\n- Implementation plan\n- Progress notes\n- QA report\n\nThe project root is: \`${project}\``].join('\n\n');

  const config: SessionConfig = {
    agentType: c.agentType,
    model: 'claude-sonnet-4-6',
    auth: { apiKey: 'sk-ant-test' },
    systemPrompt: '',
    initialMessages: [{ role: 'user', content: 'Begin.' }],
    toolContext,
    maxSteps: 50,
    specDir,
    projectDir: project,
    bundled,
    extraSkills: c.extraSkills,
    skillsOverride: c.skillsOverride?.length ? c.skillsOverride : undefined,
    agents: Object.keys(helpers).length ? helpers : undefined,
    mcpOptions: { projectCapabilities: webUi, taskTouchesUi: c.taskTouchesUi, browserMcpEnabled: true, context7Enabled: true },
  } as SessionConfig;
  const options = buildQueryOptions(config, new AbortController(), { codegraphReady: true });
  const append = (options.systemPrompt as { append?: string }).append ?? '';
  const skills = (options.skills as string[] | undefined) ?? [];
  const servers = Object.keys(options.mcpServers ?? {});

  let mcpFull = 0;
  for (const key of servers) {
    const external = EXTERNAL_MCP[key];
    if (external) {
      mcpFull += external.chars;
      continue;
    }
    const server = (options.mcpServers as Record<string, { instance?: { _registeredTools?: Record<string, { description?: string; inputSchema?: unknown }> } }>)[key];
    const registered = server.instance?._registeredTools ?? {};
    for (const [name, def] of Object.entries(registered)) {
      mcpFull += name.length + (def.description?.length ?? 0) + JSON.stringify(def.inputSchema ?? {}).length;
    }
  }

  return {
    label: c.label,
    role: tokens(rolePrompt(c.prompt).length),
    injected: tokens(injected.length),
    appended: tokens(append.length),
    skills: tokens(skills.reduce((n, s) => n + listingChars(s), 0)),
    mcpFull: tokens(mcpFull),
    mcpServers: servers,
    skillNames: skills,
  };
}

const total = (r: Row) => r.role + r.injected + r.appended + r.skills + r.mcpFull;

function table(rows: Row[]): string {
  const lines = [
    '| Agent | Role prompt | Injected (design system, QA tools, helpers, spec paths) | Runner sections | Skill listing | MCP tool definitions | Total | MCP servers | Skills |',
    '|---|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((r) => `| ${r.label} | ${r.role} | ${r.injected} | ${r.appended} | ${r.skills} | ${r.mcpFull} | ${total(r)} | ${r.mcpServers.join(', ')} | ${r.skillNames.length} |`),
  ];
  return lines.join('\n');
}

describe('starting context per agent (estimate: characters / 4)', () => {
  const rows = CASES.map(measure);

  it('writes the table when asked', () => {
    const out = process.env.CONTEXT_BUDGET_OUT;
    if (out) writeFileSync(out, `${table(rows)}\n`);
    expect(rows).toHaveLength(CASES.length);
  });

  it.skipIf(!!process.env.CONTEXT_BUDGET_BEFORE)('gives the designer the GSAP skills only in a project that animates with GSAP', () => {
    const designer = rows.find((r) => r.label.startsWith('designer'));
    expect(designer?.skillNames).toContain(FRONTEND_DESIGN_SKILL);
    expect(designer?.skillNames.some((s) => s.startsWith('gsap-skills:'))).toBe(false);
  });

  it('keeps the design system out of a non-UI coder subtask', () => {
    const nonUi = rows.find((r) => r.label === 'coder, non-UI subtask');
    const ui = rows.find((r) => r.label === 'coder, UI subtask');
    expect(nonUi && ui && nonUi.injected < ui.injected).toBe(true);
    expect(nonUi?.skillNames).not.toContain(FRONTEND_DESIGN_SKILL);
  });
});
