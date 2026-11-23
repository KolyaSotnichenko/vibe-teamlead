/**
 * A recipe made in the app that is not in the project's main branch yet: the owner's change
 * in Services, or an agent's fix of a start. It is kept in the project's settings with the
 * hash of the preview.json it replaces, used at once (recipe.ts, resolveRecipe), and written
 * into main by the app (recipe-commit.ts, settle-pending-recipe.ts). Pure.
 */

import type { PendingRecipe } from '../../shared/types/preview';
import { parseRecipe, recipeHash } from './recipe';

export { recipeFileText, recipeHash } from './recipe';

/** The same value whatever order its keys were written in */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Where a pending recipe stands against main's preview.json (null: main has none). saved: main's
 * file means the same recipe, however it is written. replaced: main has another file than the
 * one this recipe was made against, so someone changed it since and main wins. pending: neither.
 */
export function pendingState(pending: PendingRecipe, mainText: string | null): 'pending' | 'saved' | 'replaced' {
  const main = mainText === null ? undefined : parseRecipe(mainText);
  if (main?.ok && canonical(main.recipe) === canonical(pending.recipe)) return 'saved';
  return recipeHash(mainText) === pending.base ? 'pending' : 'replaced';
}
