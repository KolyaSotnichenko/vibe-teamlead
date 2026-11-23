/**
 * Every place a task can come from has its label in both locales: the task's overview shows it
 * by key, and a missing one shows the key itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import en from '../locales/en/tasks.json';
import uk from '../locales/uk/tasks.json';

/** The sources TaskMetadata allows, read from the type itself so a new one can't be added without its label */
const sources = (() => {
  const text = readFileSync(join(__dirname, '../../types/task.ts'), 'utf-8');
  const union = /sourceType\?:\s*([^;]+);/.exec(text)?.[1] ?? '';
  return [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]);
})();

describe('task source labels', () => {
  it('reads the sources from the type', () => {
    expect(sources).toEqual(expect.arrayContaining(['manual', 'base-fix', 'brief', 'deploy', 'preview-fix']));
  });

  for (const [locale, tasks] of [['en', en], ['uk', uk]] as const) {
    it(`labels every source in ${locale}`, () => {
      const labels = (tasks as unknown as { overview: { values: { source: Record<string, string> } } }).overview.values.source;
      for (const source of sources) expect(labels[source], `${locale}: overview.values.source.${source}`).toBeTruthy();
    });
  }
});
