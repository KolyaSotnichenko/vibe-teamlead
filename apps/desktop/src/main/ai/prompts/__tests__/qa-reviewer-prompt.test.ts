import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const reviewer = readFileSync(resolve(__dirname, '../../../../../prompts/qa_reviewer.md'), 'utf-8');

describe('QA reviewer prompt', () => {
  it("builds on what the app already ran: reviewers kept starting databases to run the same tests", () => {
    expect(reviewer).toMatch(/WHAT THE APP ALREADY RAN/);
    expect(reviewer).toMatch(/Don't run them again/);
  });

  it('counts those results as evidence, so a skill asking for fresh evidence is met', () => {
    expect(reviewer).toMatch(/They are evidence/);
  });

  it('reads the changes, not whole files: whole files were most of what each turn re-sent', () => {
    expect(reviewer).toMatch(/Read the diff, not the file/);
  });

  it("doesn't loosen what a review is for", () => {
    expect(reviewer).toMatch(/Acceptance Criteria Coverage \(MANDATORY\)/);
    expect(reviewer).toMatch(/You are the last line of defense/);
    expect(reviewer).toMatch(/destructive/i);
  });
});
