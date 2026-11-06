import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const coder = readFileSync(resolve(__dirname, '../../../../../prompts/coder.md'), 'utf-8');

describe('coder prompt', () => {
  it('asks for several reads or edits in one turn: every turn re-sends the whole conversation', () => {
    expect(coder).toMatch(/Do several things in one turn/);
  });

  it('keeps the whole test output in a file, with the real exit code: `| tail` hides a failure and forces a re-run', () => {
    expect(coder).toMatch(/Keep the whole test output/);
    expect(coder).toMatch(/> \/tmp\/vt-<subtask-id>\.log 2>&1; echo "exit: \$\?"/);
  });

  it("doesn't loosen test-first", () => {
    expect(coder).toMatch(/Test First \(MANDATORY\)/);
    expect(coder).toMatch(/Never edit a test to make it pass/);
  });
});
