import { describe, expect, it } from 'vitest';
import { docsFor, parseDocs, searchDocs } from '..';

describe('in-app docs', () => {
  it('ships the same topics in English and Ukrainian, each with a title', () => {
    const en = docsFor('en');
    const uk = docsFor('uk');
    expect(en.length).toBeGreaterThanOrEqual(15);
    expect(uk.map((t) => t.slug)).toEqual(en.map((t) => t.slug));
    for (const topic of [...en, ...uk]) {
      expect(topic.title).not.toBe(topic.slug);
      expect(topic.body.trim().length).toBeGreaterThan(100);
    }
  });

  it('uses the UI language, with English for languages that have no docs', () => {
    expect(docsFor('uk-UA')[0].title).toMatch(/[а-яіїєґ]/i);
    expect(docsFor('fr')[0].title).toBe(docsFor('en')[0].title);
  });

  it('parses one language and searches every word of the query', () => {
    const raw = { './en/02-b.md': '# Beta\n\nMemory and agents', './en/01-a.md': '# Alpha\n\nWorktrees', './uk/01-a.md': '# Альфа\n\nx' };
    const topics = parseDocs(raw, 'en');
    expect(topics.map((t) => t.title)).toEqual(['Alpha', 'Beta']);
    expect(topics[1].body).toBe('Memory and agents');
    expect(searchDocs(topics, 'memory agents').map((m) => m.topic.slug)).toEqual(['02-b']);
    expect(searchDocs(topics, 'memory worktrees')).toEqual([]);
    expect(searchDocs(topics, '')).toHaveLength(2);
  });

  it('has no Cyrillic left in the English pages', () => {
    for (const topic of docsFor('en')) expect(`${topic.title}\n${topic.body}`).not.toMatch(/[а-яіїєґ]/i);
  });
});
