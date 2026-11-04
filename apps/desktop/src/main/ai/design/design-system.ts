/**
 * The project's design system on disk (no Electron: used by main and worker).
 *
 * Where it lives, first match wins:
 * 1. the path set in project settings (`designSystemPath`);
 * 2. `.vibe-teamlead/design-system.md` — kept by the app;
 * 3. a file in the repository: DESIGN-SYSTEM.md in the root, design/ or docs/.
 * Tokens (`design-tokens.json`) sit next to the markdown, or in .vibe-teamlead/.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type {
  DesignQaMode,
  DesignSystemInfo,
  DesignTokens,
  ProjectSettings,
  StorybookInfo,
} from '../../../shared/types';

export const APP_DIR = '.vibe-teamlead';
export const APP_MARKDOWN = `${APP_DIR}/design-system.md`;
export const APP_TOKENS = `${APP_DIR}/design-tokens.json`;
const TOKENS_FILE = 'design-tokens.json';

/** Repository files that already are a design system (checked in this order) */
export const REPO_CANDIDATES = [
  'DESIGN-SYSTEM.md',
  'DESIGN_SYSTEM.md',
  'design-system.md',
  'design/DESIGN-SYSTEM.md',
  'design/design-system.md',
  'docs/DESIGN-SYSTEM.md',
  'docs/design-system.md',
];

const MAX_MARKDOWN_BYTES = 256 * 1024;
/** Markdown put into agent prompts is capped; the full file stays on disk */
export const PROMPT_MARKDOWN_CHARS = 14_000;

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const DesignTokensSchema = z.object({
  colors: z
    .array(z.object({ name: z.string().min(1), value: z.string().regex(HEX, 'a #hex colour'), role: z.string().optional() }))
    .default([]),
  fonts: z.array(z.object({ role: z.string().min(1), family: z.string().min(1) })).default([]),
  radius: z.array(z.number().min(0)).default([]),
  shadows: z.boolean().default(false),
  gradients: z.boolean().optional(),
  spacing: z.array(z.number().min(0)).optional(),
  bannedPatterns: z.array(z.object({ pattern: z.string().min(1), message: z.string().min(1) })).optional(),
});

type DesignSettings = Pick<ProjectSettings, 'designSystemPath' | 'designQaMode' | 'storybookEnabled'> | undefined;

function readSmall(file: string): string | undefined {
  try {
    const stats = statSync(file);
    if (!stats.isFile() || stats.size > MAX_MARKDOWN_BYTES) return undefined;
    return readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

/** A relative path inside the project, or undefined when it would escape it. */
function inside(projectPath: string, relative: string | undefined): string | undefined {
  if (!relative) return undefined;
  const resolved = path.resolve(projectPath, relative);
  const rel = path.relative(projectPath, resolved);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : undefined;
}

export interface DesignSystemPaths {
  source: DesignSystemInfo['source'];
  markdownPath: string;
  tokensPath: string;
  exists: boolean;
}

/** Where the design system is (or would be written). */
export function resolveDesignSystemPaths(projectPath: string, settings: DesignSettings): DesignSystemPaths {
  const tokensNextTo = (md: string) => {
    const sibling = path.posix.join(path.posix.dirname(md), TOKENS_FILE);
    return existsSync(path.join(projectPath, sibling)) ? sibling : APP_TOKENS;
  };
  const explicit = inside(projectPath, settings?.designSystemPath);
  if (explicit) {
    return {
      source: explicit.startsWith(`${APP_DIR}/`) ? 'app' : 'repo',
      markdownPath: explicit,
      tokensPath: tokensNextTo(explicit),
      exists: existsSync(path.join(projectPath, explicit)),
    };
  }
  if (existsSync(path.join(projectPath, APP_MARKDOWN))) {
    return { source: 'app', markdownPath: APP_MARKDOWN, tokensPath: APP_TOKENS, exists: true };
  }
  for (const candidate of REPO_CANDIDATES) {
    if (existsSync(path.join(projectPath, candidate))) {
      return { source: 'repo', markdownPath: candidate, tokensPath: tokensNextTo(candidate), exists: true };
    }
  }
  return { source: 'none', markdownPath: APP_MARKDOWN, tokensPath: APP_TOKENS, exists: false };
}

/** Parse design-tokens.json. Pure — tested directly. */
export function parseTokens(raw: string): { tokens?: DesignTokens; error?: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { error: `design-tokens.json is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed = DesignTokensSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `design-tokens.json: ${issue?.path.join('.') || 'root'} — ${issue?.message ?? 'invalid'}` };
  }
  return { tokens: parsed.data as DesignTokens };
}

/** Effective QA mode: off without a design system, block by default with one. */
export function effectiveQaMode(exists: boolean, setting: DesignQaMode | undefined): DesignQaMode {
  if (!exists) return 'off';
  return setting ?? 'block';
}

function readPackageScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/** Storybook in the project root or one level into apps/ / packages/. */
export function detectStorybook(projectPath: string, enabled: boolean): StorybookInfo {
  const dirs = ['.'];
  for (const group of ['apps', 'packages']) {
    try {
      for (const name of readdirSync(path.join(projectPath, group))) dirs.push(`${group}/${name}`);
    } catch {
      // no such folder
    }
  }
  for (const dir of dirs) {
    const abs = path.join(projectPath, dir);
    if (!existsSync(path.join(abs, '.storybook'))) continue;
    const scripts = readPackageScripts(abs);
    const script = ['storybook', 'storybook:dev', 'dev:storybook'].find((s) => scripts[s]) ??
      Object.keys(scripts).find((s) => /storybook\s+dev|start-storybook/.test(scripts[s]));
    return { detected: true, dir, script, enabled };
  }
  return { detected: false, enabled };
}

/** Everything the app shows and agents need about the design system. */
export function loadDesignSystem(projectPath: string, settings: DesignSettings): DesignSystemInfo {
  const paths = resolveDesignSystemPaths(projectPath, settings);
  const markdown = paths.exists ? readSmall(path.join(projectPath, paths.markdownPath)) : undefined;
  const tokensRaw = readSmall(path.join(projectPath, paths.tokensPath));
  const { tokens, error } = tokensRaw !== undefined ? parseTokens(tokensRaw) : {};
  const exists = markdown !== undefined;
  return {
    exists,
    source: exists ? paths.source : 'none',
    markdownPath: exists ? paths.markdownPath : undefined,
    markdown,
    tokensPath: tokens || error ? paths.tokensPath : undefined,
    tokens,
    tokensError: error,
    qaMode: effectiveQaMode(exists, settings?.designQaMode),
    storybook: detectStorybook(projectPath, settings?.storybookEnabled === true),
  };
}

/** Write the markdown and tokens where the design system lives (or into .vibe-teamlead/). */
export function saveDesignSystem(
  projectPath: string,
  settings: DesignSettings,
  content: { markdown?: string; tokens?: DesignTokens },
): DesignSystemPaths {
  const paths = resolveDesignSystemPaths(projectPath, settings);
  // A repo design system keeps its tokens next to it; the app's go in .vibe-teamlead/
  const tokensPath = paths.source === 'repo' && paths.tokensPath === APP_TOKENS
    ? path.posix.join(path.posix.dirname(paths.markdownPath), TOKENS_FILE)
    : paths.tokensPath;
  if (content.markdown !== undefined) {
    const file = path.join(projectPath, paths.markdownPath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content.markdown.endsWith('\n') ? content.markdown : `${content.markdown}\n`, 'utf-8');
  }
  if (content.tokens) {
    const parsed = DesignTokensSchema.parse(content.tokens);
    const file = path.join(projectPath, tokensPath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  }
  return { ...paths, tokensPath, exists: true };
}

/** Short, checkable summary of the tokens for prompts. Pure. */
export function tokensSummary(tokens: DesignTokens): string {
  const lines: string[] = [];
  if (tokens.colors.length) {
    lines.push('Colours (use only these — via the project\'s tokens/variables, not raw values):');
    for (const c of tokens.colors) lines.push(`- ${c.name} ${c.value}${c.role ? ` — ${c.role}` : ''}`);
  }
  if (tokens.fonts.length) lines.push(`Fonts: ${tokens.fonts.map((f) => `${f.role}: ${f.family}`).join('; ')}`);
  if (tokens.radius.length) lines.push(`Border radius: ${tokens.radius.map((r) => `${r}px`).join(', ')} only`);
  lines.push(tokens.shadows ? 'Shadows: allowed as the system defines them' : 'Shadows: none — depth comes from borders');
  if (!tokens.gradients) lines.push('Gradients: none');
  if (tokens.spacing?.length) lines.push(`Spacing scale: ${tokens.spacing.join(', ')} px`);
  for (const b of tokens.bannedPatterns ?? []) lines.push(`Never: ${b.message}`);
  return lines.join('\n');
}

/** Generic-UI tells every project avoids unless its design system says otherwise */
export const ANTI_SLOP_RULES = [
  'No purple/indigo/blue gradients, glassmorphism or glowing blobs as decoration.',
  'No grid of identical rounded cards with the same soft grey shadow for every piece of content.',
  'No emoji as icons, no stock "sparkles" decoration, no fake dashboard numbers.',
  'No tracked-out ALL-CAPS eyebrow label above every heading; no "Feature — tagline" filler copy.',
  'No centred hero + three feature cards + CTA template unless the brief asks for it.',
  'Type, colour and spacing come from the design system; one accent used for meaning, not decoration.',
  'Copy says what things do in plain words; buttons name the action ("Save changes", not "Submit").',
];

export interface DesignPromptOptions {
  /** QA gets the checking instructions; builders get the building ones */
  role: 'builder' | 'qa';
  storybookEnabled: boolean;
  storybook?: StorybookInfo;
}

/** The prompt section agents get about the design system. Pure — tested directly. */
export function designPromptSection(info: DesignSystemInfo, options: DesignPromptOptions): string {
  const parts: string[] = [];
  if (info.exists && info.markdown) {
    parts.push('## Design system (mandatory for every UI change)');
    parts.push('');
    parts.push(
      options.role === 'qa'
        ? 'Check every UI change against this design system and the anti-slop rules below. A violation is a QA issue (major), like an uncovered acceptance criterion.'
        : 'Build all UI with this design system: its tokens (colours, type, spacing, radius), its components and its rules. Do not invent new colours, fonts, radii or shadows; if something is missing, use the closest token and say so in your notes.',
    );
    parts.push(`Source: \`${info.markdownPath}\`${info.tokensPath ? `, tokens: \`${info.tokensPath}\`` : ''}.`);
    if (info.tokens) {
      parts.push('');
      parts.push(tokensSummary(info.tokens));
    }
    parts.push('');
    const md = info.markdown.length > PROMPT_MARKDOWN_CHARS
      ? `${info.markdown.slice(0, PROMPT_MARKDOWN_CHARS)}\n\n[…truncated — read the full file at ${info.markdownPath}]`
      : info.markdown;
    parts.push('<design_system>');
    parts.push(md.trim());
    parts.push('</design_system>');
  } else {
    parts.push('## UI quality');
    parts.push('');
    parts.push('This project has no design system file yet. Follow the styles already in the code (find them first), and avoid generic AI-looking UI:');
  }
  parts.push('');
  parts.push('Anti-slop rules:');
  for (const rule of ANTI_SLOP_RULES) parts.push(`- ${rule}`);
  if (options.role === 'qa' && info.exists) {
    parts.push('');
    parts.push('Design review (when UI changed): take screenshots of every changed screen and state (empty, loading, error, long text), compare them with the design system and the rules above, and add a "Design Review" table to qa_report.md: | Screen | Rule | Finding | Result |. The app also runs a static design check on the lines this task added; its results are in `design_check.md` in the spec directory (read it), and in blocking mode they arrive as QA issues.');
  }
  if (options.storybookEnabled) {
    parts.push('');
    parts.push('### Storybook');
    if (options.storybook?.detected) {
      parts.push(`Storybook is set up in \`${options.storybook.dir}\`${options.storybook.script ? ` (npm run ${options.storybook.script})` : ''}.`);
    } else {
      parts.push('Storybook is enabled for this project but not set up yet: the first UI subtask sets it up for the project\'s framework (npx storybook@latest init --yes in the UI package) and commits the config.');
    }
    parts.push(
      options.role === 'qa'
        ? 'Every new or changed UI component must have stories for its states (default, empty, loading, error, long content). Build or run Storybook and screenshot the stories of changed components as part of the design review.'
        : 'Every new or changed UI component gets a `*.stories.*` file next to it with its states: default, empty, loading, error, long content, disabled. Stories use real props, no network.',
    );
  }
  return parts.join('\n');
}
