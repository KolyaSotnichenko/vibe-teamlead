import { describe, expect, it } from 'vitest';
import { formatDate } from '../format-date';

describe('formatDate', () => {
  const iso = '2026-09-30T10:00:00Z';
  it('gives day and month in the UI language, with the year on request', () => {
    expect(formatDate(iso, 'en')).toBe(new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(new Date(iso)));
    expect(formatDate(iso, 'en', { withYear: true })).toBe(
      new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso))
    );
    expect(formatDate(iso, 'en')).toBe('Sep 30');
    expect(formatDate(iso, 'en', { withYear: true })).toBe('Sep 30, 2026');
  });

  it('localizes to Ukrainian', () => {
    const uk = formatDate(iso, 'uk');
    expect(uk).toBe(new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'short' }).format(new Date(iso)));
    expect(uk).toMatch(/^30 вер/);
    expect(formatDate(iso, 'uk', { withYear: true })).toMatch(/2026/);
  });

  it('gives an empty string for a date it cannot read', () => {
    expect(formatDate('nope', 'en')).toBe('');
  });
});
