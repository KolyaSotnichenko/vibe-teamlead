/**
 * Design system agent (main process): extract the design system from the code,
 * propose three directions from a brief, or write the full system for one.
 * Results are structured output; the caller saves them.
 */

import { z } from 'zod';

import type { DesignBrief, DesignDirection, DesignTokens } from '../../../shared/types';
import { getFeatureSettings } from '../../ipc-handlers/feature-settings-helper';
import { READ_TOOLS, runClaudeTask } from '../claude-code/task';
import type { ThinkingLevel } from '../config/types';
import { tryLoadPrompt } from '../prompts/prompt-loader';
import { progressLine } from '../runners/brief-import';
import type { StreamEvent } from '../session/types';
import { DesignTokensSchema } from './design-system';
import { readReferences, referencesPromptSection } from './references';

const HEX6 = /^#[0-9a-f]{6}$/i;

const ColorSchema = z.object({ name: z.string().min(1), value: z.string().regex(HEX6), role: z.string().optional() });
const FontSchema = z.object({ role: z.string().min(1), family: z.string().min(1) });

export const DesignSystemResultSchema = z.object({
  markdown: z.string().min(200),
  tokens: DesignTokensSchema,
});

export const DirectionsResultSchema = z.object({
  directions: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        summary: z.string().min(1),
        palette: z.array(ColorSchema).min(3).max(8),
        fonts: z.array(FontSchema).min(1).max(3),
        principles: z.array(z.string().min(1)).min(2).max(6),
      }),
    )
    .min(2)
    .max(4),
});

export class DesignAgentError extends Error {}

interface RunOptions {
  projectPath: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

function systemPrompt(): string {
  const prompt = tryLoadPrompt('design_system');
  if (!prompt) throw new DesignAgentError('The design system prompt is missing from this build.');
  return prompt;
}

function briefText(brief: DesignBrief): string {
  return [
    `Product: ${brief.product.trim()}`,
    brief.audience?.trim() ? `Audience: ${brief.audience.trim()}` : '',
    brief.mood?.trim() ? `Mood and references: ${brief.mood.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The user's references for the design jobs (empty when there are none). */
function referencesFor(projectPath: string): string {
  return referencesPromptSection(readReferences(projectPath), { audience: 'design', projectPath });
}

function progress(onProgress: RunOptions['onProgress'], projectPath: string) {
  return (event: StreamEvent) => {
    const line = progressLine(event, projectPath);
    if (line) onProgress?.(line);
  };
}

/** EXTRACT: the design system the code already has. */
export async function extractDesignSystem(options: RunOptions): Promise<{ markdown: string; tokens: DesignTokens }> {
  const feature = getFeatureSettings('designSystem');
  options.onProgress?.('Reading the project styles and components');
  const result = await runClaudeTask({
    systemPrompt: systemPrompt(),
    prompt: [
      'Job: EXTRACT.',
      `The project root is ${options.projectPath}.`,
      'Find the visual language the code already uses and write it down as the design system (markdown + tokens).',
      '',
      referencesFor(options.projectPath),
    ].join('\n'),
    model: feature.model,
    thinkingLevel: feature.thinkingLevel as ThinkingLevel,
    tools: READ_TOOLS,
    cwd: options.projectPath,
    agentType: 'design_system',
    outputSchema: DesignSystemResultSchema,
    maxTurns: 60,
    abortSignal: options.signal,
    onEvent: progress(options.onProgress, options.projectPath),
  });
  if (!result.output) throw new DesignAgentError('The agent returned no design system.');
  return result.output as { markdown: string; tokens: DesignTokens };
}

/** DIRECTIONS: three distinct visual directions for a brief. */
export async function proposeDirections(options: RunOptions & { brief: DesignBrief }): Promise<DesignDirection[]> {
  if (!options.brief.product.trim()) throw new DesignAgentError('Describe the product first.');
  const feature = getFeatureSettings('designSystem');
  options.onProgress?.('Thinking about directions');
  const result = await runClaudeTask({
    systemPrompt: systemPrompt(),
    prompt: [
      'Job: DIRECTIONS.',
      `The project root is ${options.projectPath} (you may glance at it to understand the product; do not extract its styles).`,
      '',
      briefText(options.brief),
      '',
      referencesFor(options.projectPath),
    ].join('\n'),
    model: feature.model,
    thinkingLevel: feature.thinkingLevel as ThinkingLevel,
    tools: READ_TOOLS,
    cwd: options.projectPath,
    agentType: 'design_system',
    outputSchema: DirectionsResultSchema,
    maxTurns: 20,
    abortSignal: options.signal,
    onEvent: progress(options.onProgress, options.projectPath),
  });
  if (!result.output) throw new DesignAgentError('The agent returned no directions.');
  return (result.output as z.infer<typeof DirectionsResultSchema>).directions;
}

/** WRITE: the full design system for the chosen direction. */
export async function writeDesignSystem(
  options: RunOptions & { brief: DesignBrief; direction: DesignDirection },
): Promise<{ markdown: string; tokens: DesignTokens }> {
  const feature = getFeatureSettings('designSystem');
  options.onProgress?.(`Writing the design system for "${options.direction.name}"`);
  const result = await runClaudeTask({
    systemPrompt: systemPrompt(),
    prompt: [
      'Job: WRITE.',
      `The project root is ${options.projectPath}.`,
      '',
      briefText(options.brief),
      '',
      'Chosen direction (keep its palette and fonts; you may add neutral shades the system needs):',
      JSON.stringify(options.direction, null, 2),
      '',
      referencesFor(options.projectPath),
    ].join('\n'),
    model: feature.model,
    thinkingLevel: feature.thinkingLevel as ThinkingLevel,
    tools: READ_TOOLS,
    cwd: options.projectPath,
    agentType: 'design_system',
    outputSchema: DesignSystemResultSchema,
    maxTurns: 20,
    abortSignal: options.signal,
    onEvent: progress(options.onProgress, options.projectPath),
  });
  if (!result.output) throw new DesignAgentError('The agent returned no design system.');
  return result.output as { markdown: string; tokens: DesignTokens };
}
