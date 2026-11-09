import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const analyst = readFileSync(resolve(__dirname, '../../../../../prompts/brief_analyst.md'), 'utf-8');

describe('brief analyst prompt', () => {
  it("checks that every page can be reached: a 25-task brief shipped with the scaffold's placeholder still at /", () => {
    expect(analyst).toMatch(/## ENTRY POINTS AND NAVIGATION/);
    expect(analyst).toMatch(/home page/i);
    expect(analyst).toMatch(/reach(ed|able)/i);
    expect(analyst).toMatch(/after (signing|sign) in/i);
  });

  it('makes a task that leaves temporary scaffolding name the task that replaces it', () => {
    expect(analyst).toMatch(/placeholder/i);
    expect(analyst).toMatch(/which later task replaces it/i);
  });
});
