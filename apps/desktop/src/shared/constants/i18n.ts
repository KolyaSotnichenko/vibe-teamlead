/**
 * Internationalization constants
 * Available languages and display labels
 */

export type SupportedLanguage = 'en' | 'uk';

export const AVAILABLE_LANGUAGES = [
  { value: 'en' as const, label: 'English', nativeLabel: 'English' },
  { value: 'uk' as const, label: 'Ukrainian', nativeLabel: 'Українська' }
] as const;

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = AVAILABLE_LANGUAGES.map((lang) => lang.value);

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Turn any stored or reported language value into a language the app ships.
 *
 * A supported value is kept as is. Anything else (a removed language such as
 * a saved 'fr', a regional code, garbage) falls back to the OS language when
 * the app has it (e.g. 'uk-UA' -> 'uk'), and otherwise to English.
 */
export function resolveSupportedLanguage(value: unknown, systemLocale?: string | null): SupportedLanguage {
  if (isSupportedLanguage(value)) return value;
  const base = typeof systemLocale === 'string' ? systemLocale.split(/[-_]/)[0]?.toLowerCase() : undefined;
  return isSupportedLanguage(base) ? base : DEFAULT_LANGUAGE;
}
