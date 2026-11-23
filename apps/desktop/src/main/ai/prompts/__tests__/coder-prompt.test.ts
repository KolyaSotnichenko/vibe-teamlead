import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const coder = readFileSync(resolve(__dirname, '../../../../../prompts/coder.md'), 'utf-8');

describe('coder prompt', () => {
  it('asks for several reads or edits in one turn: every turn re-sends the whole conversation', () => {
    expect(coder).toMatch(/Do several things in one turn/);
  });

  it('runs tests as they are, so the app keeps the log and shows the failing lines: `| tail` hides a failure and forces a re-run', () => {
    expect(coder).toMatch(/Run tests and checks as they are/);
    expect(coder).toMatch(/no `\|`, `>` or `tail`/);
    expect(coder).not.toMatch(/\/tmp\/vt-<subtask-id>/);
  });

  it('names only the CodeGraph tool the bundled server lists (the others are unlisted by default)', () => {
    expect(coder).toMatch(/`codegraph_explore`/);
    expect(coder).not.toMatch(/codegraph_(search|node|callers|callees|impact|context)/);
  });

  it("doesn't loosen test-first", () => {
    expect(coder).toMatch(/### Test first/);
    expect(coder).toMatch(/red → green → refactor/);
    expect(coder).toMatch(/Never edit a test to make it pass/);
  });

  it('keeps preview.json true in the same task: the app starts the project by it, in the Preview and before QA', () => {
    expect(coder).toMatch(/### preview\.json/);
    const section = coder.slice(coder.indexOf('### preview.json'), coder.indexOf('###', coder.indexOf('### preview.json') + 5));
    for (const key of ['"version": 1', '"kind": "web"', '"services"', '"port"', '"ready"', '"page": true', '"steps"']) expect(section).toContain(key);
    expect(section).toMatch(/blocks the task|blocked/);
    expect(section).toMatch(/never a secret/i);
    expect(section).toMatch(/connection setting/i);
  });

  it('keeps RUNNING.md up to date in the same task: the preview falls back to it for projects it cannot run', () => {
    expect(coder).toMatch(/### RUNNING\.md/);
    for (const section of ['Prerequisites', 'Setup', 'Database', 'Start', 'Signing in locally', 'Common problems']) expect(coder).toContain(`**${section}**`);
    expect(coder).toMatch(/never real values/);
    expect(coder).toMatch(/create it/);
  });
});
