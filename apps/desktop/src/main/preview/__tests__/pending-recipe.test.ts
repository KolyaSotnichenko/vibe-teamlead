import { describe, expect, it } from 'vitest';

import type { PendingRecipe, PreviewRecipe } from '../../../shared/types/preview';
import { pendingState, recipeFileText, recipeHash } from '../pending-recipe';
import { parseRecipe } from '../recipe';

const RECIPE: PreviewRecipe = { version: 1, kind: 'web', services: [{ name: 'web', dir: '', command: 'npm run dev', page: true }] };
const pending = (base: string): PendingRecipe => ({ recipe: RECIPE, base, origin: 'owner', at: '2026-11-23T10:00:00.000Z' });

describe('a pending recipe', () => {
  it('writes a recipe as indented JSON with a final newline, which parses back to it', () => {
    const text = recipeFileText(RECIPE);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "version": 1');
    expect(parseRecipe(text)).toEqual({ ok: true, recipe: RECIPE });
  });

  it("hashes a file's text, and says none for no file", () => {
    expect(recipeHash(null)).toBe('none');
    expect(recipeHash('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(recipeHash('a')).not.toBe(recipeHash('b'));
  });

  it('is pending while main still has the file it was made against', () => {
    expect(pendingState(pending('none'), null)).toBe('pending');
    expect(pendingState(pending(recipeHash('{"version":1,"kind":"none"}')), '{"version":1,"kind":"none"}')).toBe('pending');
  });

  it("is saved once main's file means the same recipe, however it is written", () => {
    const reordered = JSON.stringify({ kind: 'web', services: [{ page: true, command: 'npm run dev', dir: '', name: 'web' }], version: 1 });
    expect(pendingState(pending('none'), reordered)).toBe('saved');
    expect(pendingState(pending('none'), recipeFileText(RECIPE))).toBe('saved');
  });

  it('is replaced once main has another file than the one it was made against', () => {
    expect(pendingState(pending('none'), '{"version":1,"kind":"none"}')).toBe('replaced');
    expect(pendingState(pending(recipeHash('old')), null)).toBe('replaced');
  });
});
