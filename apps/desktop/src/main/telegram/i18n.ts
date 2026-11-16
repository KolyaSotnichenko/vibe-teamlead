/**
 * Bot messages in the app language: the `bot` part of the `telegram` namespace, the same files
 * the window uses (en, uk). A small translator (interpolation and plural forms by the
 * language's rules), so the main process does not need i18next.
 */

import en from '../../shared/i18n/locales/en/telegram.json';
import uk from '../../shared/i18n/locales/uk/telegram.json';

type Tree = { [key: string]: string | Tree };

const BOT: Record<string, Tree> = { en: en.bot as Tree, uk: uk.bot as Tree };

function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    if (!node || typeof node === 'string') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export type BotVars = Record<string, string | number>;

export function botText(language: string, key: string, vars: BotVars = {}): string {
  const lang = BOT[language] ? language : 'en';
  let text: string | undefined;
  if (typeof vars.count === 'number') {
    const form = new Intl.PluralRules(lang).select(vars.count);
    text = lookup(BOT[lang], `${key}_${form}`) ?? lookup(BOT[lang], `${key}_other`);
  }
  text ??= lookup(BOT[lang], key) ?? lookup(BOT.en, key);
  if (text === undefined) return key;
  return text.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export type Translate = (key: string, vars?: BotVars) => string;

/** A translator that follows the app language at call time */
export function translatorFor(language: () => string): Translate {
  return (key, vars) => botText(language(), key, vars);
}
