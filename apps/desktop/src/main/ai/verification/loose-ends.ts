/**
 * Placeholders left in the product: "coming soon", "lorem ipsum", a page that says it is a
 * placeholder. One task ships them on purpose and no later task owns replacing them, so
 * they outlive the whole build (roadmaply's home page did, through 23 tasks). A plain text
 * search over UI files, no model: cheap enough to run whenever the board is shown.
 * Pure: no Electron imports, no file access.
 */

import type { LooseEnd } from '../../../shared/types/project';
import type { ProjectFiles } from './detect-checks';

export type { LooseEnd };

/** Files a user sees: page templates and components, in any stack */
const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html?|erb|hbs|handlebars|ejs|pug|twig|njk|liquid|mdx|cshtml|razor)$|\.blade\.php$/i;
/** Not the product: tests, stories, generated, vendored, the app's own files */
const SKIPPED = /(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.vibe-teamlead|\.git|e2e|__tests__|__mocks__|tests?|storybook-static)\/|\.(test|spec|stories|story)\.[^/]+$/i;

const MARKERS: RegExp[] = [
  /\bplaceholder\s+(?:home\s+)?(?:page|screen|content|text|view|section|copy)\b/i,
  /\b(?:page|screen|section)\s+is\s+(?:a\s+|just\s+a\s+)?placeholder\b/i,
  /\bcoming soon\b/i,
  /\blorem ipsum\b/i,
  /\bunder construction\b/i,
  /\bnot (?:yet )?implemented\b/i,
  // A TODO the user would see: inside a string or between tags, not a code comment
  /(?:['"`>]\s*)(?:TODO|FIXME)\b/,
];

const MAX_FOUND = 50;
const TEXT_MAX = 160;

/** The files the search reads: UI files that are part of the product, in order. Pure. */
export function looseEndFiles(files: string[]): string[] {
  return files.filter((f) => UI_FILE.test(f) && !SKIPPED.test(f)).sort();
}

export function findLooseEnds({ files, read }: ProjectFiles): LooseEnd[] {
  const found: LooseEnd[] = [];
  for (const file of looseEndFiles(files)) {
    const lines = (read(file) ?? '').split('\n');
    for (let i = 0; i < lines.length && found.length < MAX_FOUND; i++) {
      if (!MARKERS.some((marker) => marker.test(lines[i]))) continue;
      const text = lines[i].trim();
      found.push({ file, line: i + 1, text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text });
    }
    if (found.length >= MAX_FOUND) break;
  }
  return found;
}

export { looseEndKey } from '../../../shared/utils/loose-end-key';
