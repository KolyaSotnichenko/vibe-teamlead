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

// Most of what the designer wrote was the same CSS in every page, and whole files rewritten (planner-mhp)
describe('the designer writes each thing once', () => {
  it('shares one stylesheet per folder and changes files with Edit', () => {
    const text = prompt('designer.md');
    expect(text).toContain('<link rel="stylesheet" href="styles.css">');
    expect(text).not.toMatch(/styles in one `<style>`/);
    expect(text).toMatch(/change it with Edit/);
    expect(text).toMatch(/Don't Read a file you have just written/);
  });
});

// The app lists what a person can use on each screen from the HTML; notes about the prototype are not part of it
describe("the designer's notes about the prototype", () => {
  it('go in <aside class="proto">, which the app leaves out', () => {
    expect(prompt('designer.md')).toContain('<aside class="proto">');
  });
});
