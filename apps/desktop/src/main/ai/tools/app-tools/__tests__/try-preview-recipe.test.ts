import { describe, expect, it, vi } from 'vitest';

import type { ToolContext } from '../../types';
import { tryPreviewRecipeTool } from '../try-preview-recipe';

const RECIPE = { version: 1, kind: 'web', services: [{ name: 'web', dir: '', command: 'npm run dev', page: true }] };
const run = (input: unknown, context: Partial<ToolContext>) => tryPreviewRecipeTool.config.execute(input as never, { cwd: '/wt', specDir: '/wt', projectDir: '/wt', ...context } as unknown as ToolContext) as Promise<string>;

describe('try_preview_recipe', () => {
  it('is named as the agent is told, and takes a recipe', () => {
    expect(tryPreviewRecipeTool.metadata.name).toBe('mcp__vibe-teamlead__try_preview_recipe');
    expect(tryPreviewRecipeTool.config.inputSchema.safeParse({ recipe: RECIPE }).success).toBe(true);
    expect(tryPreviewRecipeTool.config.inputSchema.safeParse({}).success).toBe(false);
  });

  it('hands the recipe to the app, and answers with what the app says happened', async () => {
    const tryPreviewRecipe = vi.fn(async () => 'Started: the page answers at http://localhost:5173.');
    await expect(run({ recipe: RECIPE }, { tryPreviewRecipe })).resolves.toBe('Started: the page answers at http://localhost:5173.');
    expect(tryPreviewRecipe).toHaveBeenCalledWith(RECIPE);
  });

  it('says so in a session where no preview is being fixed', async () => {
    await expect(run({ recipe: RECIPE }, {})).resolves.toBe('Error: no preview is being fixed in this session.');
  });

  it('answers with an error, and does not throw, when the start itself throws', async () => {
    const tryPreviewRecipe = vi.fn(async () => {
      throw new Error('The preview was stopped.');
    });
    await expect(run({ recipe: RECIPE }, { tryPreviewRecipe })).resolves.toBe('Error: The preview was stopped.');
  });
});
