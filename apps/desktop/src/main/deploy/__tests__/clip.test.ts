import { describe, expect, it } from 'vitest';

import { clip, clipLine } from '../clip';

describe('clip', () => {
  it('keeps short text as it is', () => {
    expect(clip('abc', 10)).toBe('abc');
    expect(clipLine('abc', 10)).toBe('abc');
  });

  it('cuts long text to the limit, with an ellipsis', () => {
    const out = clip('x'.repeat(50), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('clip keeps newlines; clipLine turns them into spaces', () => {
    expect(clip('a\nb', 10)).toBe('a\nb');
    expect(clipLine('a\r\nb\nc', 10)).toBe('a b c');
    expect(clipLine('### x\n## y', 100)).not.toContain('\n');
  });
});
