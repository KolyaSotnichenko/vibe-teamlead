/**
 * The app runs on macOS and Windows: UI strings (en, uk) and documentation pages must not
 * assume a Mac. No "this Mac", no ⌘-only shortcuts (the UI fills shortcuts in per platform;
 * docs give "⌘T / Ctrl+T"), no "macOS Keychain", no "a macOS app", and every Homebrew
 * command in the docs comes with a way to install it on Windows (winget or pip).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES_DIR = join(__dirname, '..', 'locales');
const DOCS_DIR = join(__dirname, '..', '..', '..', 'renderer', 'docs');

const MAC = /\bMac\b/;
const KEYCHAIN = /Keychain/i;
const MACOS_APP = /a macOS app|застосунок для macOS(?! і Windows)/i;

function strings(value: unknown, path: string, out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') out.push([path, value]);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

describe('no Mac-only wording in the UI and docs', () => {
  it('locale strings (en, uk)', () => {
    const bad: string[] = [];
    for (const lang of ['en', 'uk']) {
      for (const file of readdirSync(join(LOCALES_DIR, lang)).filter((f) => f.endsWith('.json'))) {
        const json = JSON.parse(readFileSync(join(LOCALES_DIR, lang, file), 'utf8'));
        for (const [key, text] of strings(json, '')) {
          if (MAC.test(text) || text.includes('⌘') || KEYCHAIN.test(text) || MACOS_APP.test(text)) bad.push(`${lang}/${file} ${key}: ${text}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('documentation pages (en, uk)', () => {
    const bad: string[] = [];
    for (const lang of ['en', 'uk']) {
      for (const file of readdirSync(join(DOCS_DIR, lang)).filter((f) => f.endsWith('.md'))) {
        readFileSync(join(DOCS_DIR, lang, file), 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const where = `${lang}/${file}:${i + 1}`;
            if (MAC.test(line)) bad.push(`${where} says "Mac"`);
            if (MACOS_APP.test(line)) bad.push(`${where} calls the app macOS-only`);
            if (/macOS Keychain|Keychain macOS/.test(line)) bad.push(`${where} names only the macOS Keychain`);
            if (line.includes('⌘') && !line.includes('Ctrl')) bad.push(`${where} gives only the ⌘ shortcut`);
            if (/brew install/.test(line) && !/winget|pip install/.test(line)) bad.push(`${where} gives only Homebrew`);
          });
      }
    }
    expect(bad).toEqual([]);
  });
});
