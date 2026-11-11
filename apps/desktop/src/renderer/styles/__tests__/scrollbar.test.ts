/**
 * The content area's native scrollbar matches ScrollArea's: thin, the hairline colour, radius 0, in
 * both themes. (Opacity on ::-webkit-scrollbar-thumb has no effect, so a solid muted-foreground thumb
 * rendered as a thick dark bar in light mode.)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(__dirname, '..', 'globals.css'), 'utf-8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

describe('native scrollbar', () => {
  it('is thin', () => {
    expect(rule('::-webkit-scrollbar')).toMatch(/width:\s*8px/);
  });

  it('has a quiet hairline thumb with radius 0 and no opacity trick, in light and dark', () => {
    for (const selector of ['::-webkit-scrollbar-thumb', '.dark ::-webkit-scrollbar-thumb']) {
      const body = rule(selector);
      expect(body).toMatch(/background(-color)?:\s*var\(--border\)/);
      expect(body).not.toMatch(/opacity/);
      expect(body).not.toMatch(/muted-foreground\)\s*;/);
    }
    expect(rule('::-webkit-scrollbar-thumb')).toMatch(/border-radius:\s*0/);
  });
});

describe('ScrollArea thumb', () => {
  it('has radius 0 and the hairline colour', () => {
    // jsdom does not lay out a Radix thumb, so the component's class list is the contract
    const source = readFileSync(path.join(__dirname, '..', '..', 'components', 'ui', 'scroll-area.tsx'), 'utf-8');
    expect(source).not.toMatch(/ScrollAreaThumb className="[^"]*rounded-full/);
    expect(source).toMatch(/ScrollAreaThumb className="[^"]*bg-border/);
  });
});
