import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const prompt = (name: string) => readFileSync(resolve(__dirname, '../../../../../prompts', name), 'utf-8');

// A spec once asked for "a small, unstyled test sign-in form": the first thing the owner saw
describe('every screen a person can see follows the design system', () => {
  it.each(['spec_writer.md', 'spec_quick.md', 'spec_gatherer.md', 'designer.md', 'coder.md'])('%s says so, test-only screens included', (name) => {
    const text = prompt(name);
    expect(text).toMatch(/follows? the project's design system/);
    expect(text).toMatch(/test|dev-only/);
    expect(text).not.toMatch(/unstyled (test|form|page|screen)/i);
  });

  it('asks the spec for a convenient, styled local sign-in', () => {
    expect(prompt('spec_writer.md')).toMatch(/Sign in as <role>/);
  });
});
