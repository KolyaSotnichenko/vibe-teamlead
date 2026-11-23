/**
 * try_preview_recipe Tool
 * =======================
 *
 * For the agent that fixes a preview start (preview/fix-start.ts): it hands the app a recipe,
 * the app starts the project by it as it starts any preview, and says what happened. The
 * agent starts nothing itself, so this is its only proof that a recipe works.
 */

import { z } from 'zod/v3';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

export const tryPreviewRecipeTool = Tool.define({
  metadata: {
    name: 'mcp__vibe-teamlead__try_preview_recipe',
    description:
      "Give the app a recipe (the content of preview.json) to start the project by. The app starts it exactly as it does for the owner and answers with what happened: that the page answers, or the stage and service that failed with the end of the log. A recipe the app refuses to try comes back with the reason and does not count as a try.",
    permission: ToolPermission.Auto,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema: z.object({
    recipe: z.record(z.unknown()).describe('The whole recipe as a JSON object: { "version": 1, "kind": "web", "services": [...], "steps": {...}, "env": {...} }'),
  }),
  execute: async (input, context) => {
    if (!context.tryPreviewRecipe) return 'Error: no preview is being fixed in this session.';
    try {
      return await context.tryPreviewRecipe(input.recipe);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
