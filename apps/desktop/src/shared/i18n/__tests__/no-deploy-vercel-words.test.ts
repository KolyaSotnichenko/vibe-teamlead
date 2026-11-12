/**
 * The Deploy area is called CI and Vercel is gone from the app: no UI string (en, uk)
 * and no documentation page may use "Vercel" or "Deploy"/"Деплой" as a UI word.
 * Exempt: the name of the UX-review guidelines ("Vercel's Web Interface Guidelines",
 * "Web Interface Guidelines від Vercel") and "deployment" words of other products
 * (Azure embedding deployment), which the whole-word match below does not catch.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES_DIR = join(__dirname, '..', 'locales');
const DOCS_DIR = join(__dirname, '..', '..', '..', 'renderer', 'docs');

const EXEMPT = [/Vercel['’]s Web Interface Guidelines/g, /Web Interface Guidelines від Vercel/g];
const VERCEL = /vercel/i;
const DEPLOY = /\bdeploy(?:s|ed|ing)?\b|деплой|деплої/i;

function strings(value: unknown, path: string, out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') out.push([path, value]);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

function offenders(text: string): string[] {
  let t = text;
  for (const e of EXEMPT) t = t.replace(e, '');
  const found: string[] = [];
  if (VERCEL.test(t)) found.push('Vercel');
  if (DEPLOY.test(t)) found.push('Deploy');
  return found;
}

describe('no Vercel or Deploy words in the UI and docs', () => {
  it('locale strings (en, uk)', () => {
    const bad: string[] = [];
    for (const lang of ['en', 'uk']) {
      for (const file of readdirSync(join(LOCALES_DIR, lang)).filter((f) => f.endsWith('.json'))) {
        const json = JSON.parse(readFileSync(join(LOCALES_DIR, lang, file), 'utf-8'));
        for (const [key, text] of strings(json, '')) {
          const hits = offenders(text);
          if (hits.length) bad.push(`${lang}/${file} ${key}: ${hits.join(', ')}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('documentation pages (en, uk)', () => {
    const bad: string[] = [];
    for (const lang of ['en', 'uk']) {
      for (const file of readdirSync(join(DOCS_DIR, lang)).filter((f) => f.endsWith('.md'))) {
        const hits = offenders(readFileSync(join(DOCS_DIR, lang, file), 'utf-8'));
        if (hits.length) bad.push(`${lang}/${file}: ${hits.join(', ')}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
