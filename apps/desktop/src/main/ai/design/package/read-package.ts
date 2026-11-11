/**
 * Reads what an unpacked design-system package holds. Pure file reading:
 * nothing from the package is executed; bundle.js is read only for the first
 * 2 KB, as text, to find its `@ds-bundle` header.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, lstatSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

export interface DesignPackage {
  /** Relative to the package folder: '' or the single top folder. */
  root: string;
  name: string;
  namespace: string;
  /** Paths below are POSIX, relative to the package folder. */
  readme?: string;
  tokenFiles: { dtcg?: string; json?: string; css?: string };
  components: Array<{ name: string; readme?: string }>;
  componentFiles: { css?: string; types?: string; script?: string };
  logos: string[];
  fonts: string[];
  /** Images and PDFs outside logos/, fonts/, components/. */
  extraReferences: string[];
  licenceLine?: string;
}

const IMAGE_OR_PDF = /\.(png|jpe?g|webp|gif|svg|pdf)$/i;
const FONT_FILE = /\.(otf|ttf|woff2?)$/i;
const LICENCE = /licen[cs]|ліценз|комерц|commercial/i;
const FONT_WORD = /font|шрифт/i;

function ignorable(name: string): boolean {
  return name.startsWith('.') || name === '__MACOSX';
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !ignorable(n)).sort();
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const MAX_DEPTH = 12;
const MAX_FILES = 5000;

/** Lists regular files only: symbolic links and special files are skipped, depth and count are capped. */
function walkFiles(dir: string, rel: string, out: string[], depth = 0): void {
  if (depth > MAX_DEPTH) return;
  for (const name of listDir(dir)) {
    if (out.length >= MAX_FILES) return;
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walkFiles(abs, r, out, depth + 1);
    else if (st.isFile()) out.push(r);
  }
}

function readHead(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function bundleNamespace(script: string): string | undefined {
  const m = /^\s*\/\*\s*@ds-bundle:\s*(\{[^\n]*?\})\s*\*\//.exec(script);
  if (!m) return undefined;
  try {
    const ns = (JSON.parse(m[1]) as { namespace?: unknown }).namespace;
    return typeof ns === 'string' && ns ? ns : undefined;
  } catch {
    return undefined;
  }
}

function cssPrefix(cssFile: string): string | undefined {
  let css: string;
  try {
    css = readFileSync(cssFile, 'utf8');
  } catch {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/\.([a-z][a-z0-9]*)-[a-z0-9]/gi)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function findLicenceLine(readme: string): string | undefined {
  for (const line of readme.split(/\r?\n/)) {
    if (!LICENCE.test(line)) continue;
    const sentences = line.split(/(?<=[.!?])\s+/);
    const hit = sentences.find((s) => LICENCE.test(s) && FONT_WORD.test(s)) ??
      (FONT_WORD.test(line) ? sentences.find((s) => LICENCE.test(s)) : undefined);
    if (hit) return line.trim();
  }
  return undefined;
}

export function readDesignPackage(dir: string): DesignPackage {
  const top = listDir(dir);
  const root = top.length === 1 && isDir(path.join(dir, top[0])) ? top[0] : '';
  const base = root ? path.join(dir, root) : dir;
  const rel = (p: string): string => (root ? `${root}/${p}` : p);
  const has = (p: string): boolean => existsSync(path.join(base, p));
  const pick = (p: string): string | undefined => (has(p) ? rel(p) : undefined);

  const readmeRel = pick('README.md');
  let readmeText = '';
  if (readmeRel) {
    try {
      readmeText = readFileSync(path.join(base, 'README.md'), 'utf8');
    } catch {
      readmeText = '';
    }
  }
  const heading = /^#\s+(.+?)\s*$/m.exec(readmeText)?.[1];
  const name = heading || root || path.basename(path.resolve(dir));

  const componentFiles: DesignPackage['componentFiles'] = {};
  const css = pick('components/bundle.css');
  const types = pick('components/index.d.ts');
  const script = pick('components/bundle.js');
  if (css) componentFiles.css = css;
  if (types) componentFiles.types = types;
  if (script) componentFiles.script = script;

  let namespace: string | undefined;
  if (script) {
    try {
      namespace = bundleNamespace(readHead(path.join(base, 'components/bundle.js'), 2048));
    } catch {
      namespace = undefined;
    }
  }
  if (!namespace && css) namespace = cssPrefix(path.join(base, 'components/bundle.css'));

  const names: string[] = [];
  for (const n of listDir(path.join(base, 'components'))) {
    if (isDir(path.join(base, 'components', n))) names.push(n);
  }
  if (types) {
    try {
      const d = readFileSync(path.join(base, 'components/index.d.ts'), 'utf8');
      for (const m of d.matchAll(/export\s+declare\s+function\s+([A-Za-z_$][\w$]*)/g)) {
        if (!names.includes(m[1])) names.push(m[1]);
      }
    } catch {
      // unreadable types file: folders alone define the components
    }
  }
  const components = names.map((n) => {
    const readme = pick(`components/${n}/README.md`);
    return readme ? { name: n, readme } : { name: n };
  });

  const all: string[] = [];
  walkFiles(base, '', all);
  const logos = all.filter((f) => f.startsWith('logos/') && IMAGE_OR_PDF.test(f)).map(rel);
  const fonts = all.filter((f) => f.startsWith('fonts/') && FONT_FILE.test(f)).map(rel);
  const extraReferences = all
    .filter(
      (f) =>
        IMAGE_OR_PDF.test(f) &&
        !f.startsWith('logos/') &&
        !f.startsWith('fonts/') &&
        !f.startsWith('components/'),
    )
    .map(rel);

  const tokenFiles: DesignPackage['tokenFiles'] = {};
  const dtcg = pick('tokens.dtcg.json');
  const json = pick('tokens.json');
  const tcss = pick('tokens.css');
  if (dtcg) tokenFiles.dtcg = dtcg;
  if (json) tokenFiles.json = json;
  if (tcss) tokenFiles.css = tcss;

  const pkg: DesignPackage = {
    root,
    name,
    namespace: namespace ?? 'ds',
    tokenFiles,
    components,
    componentFiles,
    logos,
    fonts,
    extraReferences,
  };
  if (readmeRel) pkg.readme = readmeRel;
  const licence = findLicenceLine(readmeText);
  if (licence) pkg.licenceLine = licence;
  return pkg;
}
