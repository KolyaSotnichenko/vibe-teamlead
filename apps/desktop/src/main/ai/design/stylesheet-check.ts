/**
 * Whether the app loads the stylesheets of its imported design system. In one project the
 * component stylesheet (the body font, every component's styles) was copied into the repository
 * and listed in a package, but nothing imported it: every page lost its font and components, the
 * tests (which see no CSS) passed, and nobody noticed for 28 tasks. The design check runs this
 * before each QA review of a task that changed UI. No Electron imports.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { DesignFinding, DesignPackageInfo } from '../../../shared/types';
import { runProcess } from '../../platform/exec';
import { withoutGitLocation } from '../../platform/git-env';
import { readOnlyGitArgs } from '../orchestration/reviewer-changes';

/** Text files that can load a stylesheet */
const SOURCE = /\.(m?[jt]sx?|cjs|css|scss|sass|less|html?|vue|svelte|astro)$/i;
const SKIPPED = /(^|\/)(\.vibe-teamlead|node_modules|dist|build|out|coverage|\.next|\.git)\//;
const MAX_FILE = 512 * 1024;
const MAX_FILES = 8000;

/** What a file loads: import / @import / require / <link href>, as written. */
function loadedPaths(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bimport\s*(?:[\w*{}\s,]+\s+from\s*)?\(?\s*['"]([^'"]+)['"]/g,
    /@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
    /<link\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"]/gi,
  ];
  for (const pattern of patterns) for (const m of text.matchAll(pattern)) out.push(m[1]);
  return out;
}

const normalized = (css: string) => css.replace(/\s+/g, ' ').trim();

/**
 * The stylesheets of the package that no project file loads, under their own name or the name of
 * a copy of them in the project. Pure.
 */
export function unloadedStylesheets(
  sheets: Array<{ path: string; content: string }>,
  projectFiles: Array<{ path: string; text: string }>,
): DesignFinding[] {
  if (!sheets.length) return [];
  const loaded = new Set(projectFiles.flatMap((f) => loadedPaths(f.text)).map((p) => path.posix.basename(p.split(/[?#]/)[0])));
  const findings: DesignFinding[] = [];
  for (const sheet of sheets) {
    const content = normalized(sheet.content);
    const names = new Set([path.posix.basename(sheet.path)]);
    for (const file of projectFiles) {
      if (/\.css$/i.test(file.path) && normalized(file.text) === content) names.add(path.posix.basename(file.path));
    }
    if ([...names].some((name) => loaded.has(name))) continue;
    const name = path.posix.basename(sheet.path);
    findings.push({
      rule: 'stylesheet-not-loaded',
      file: sheet.path,
      line: 1,
      match: name,
      message: `${name} of the design system is not loaded: no file of the app imports it (or a copy of it), so its styles (fonts, components) are missing from every page. Import it once in the app's entry, after the tokens and before the app's own styles.`,
    });
  }
  return findings;
}

/** The package's stylesheets that the project at `projectDir` does not load. Never throws. */
export async function checkDesignStylesheets(projectDir: string, pkg: Pick<DesignPackageInfo, 'componentCss' | 'tokensCss'>): Promise<DesignFinding[]> {
  try {
    const sheets: Array<{ path: string; content: string }> = [];
    for (const sheet of [pkg.tokensCss, pkg.componentCss]) {
      if (!sheet) continue;
      const content = await readFile(path.join(projectDir, sheet), 'utf-8').catch(() => null);
      if (content !== null) sheets.push({ path: sheet, content });
    }
    if (!sheets.length) return [];
    // Agents can write the repository's git config: no hook, fsmonitor or other command of theirs runs here
    const listed = await runProcess('git', readOnlyGitArgs(['ls-files', '-z', '--cached', '--others', '--exclude-standard']), {
      cwd: projectDir,
      // Nor a fetch from a remote (a partial clone fetches missing objects on demand)
      env: { ...withoutGitLocation(), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
      timeoutMs: 30_000,
    });
    if (listed.code !== 0) return [];
    const paths = [...new Set(listed.stdout.split('\0'))].filter((p) => p && SOURCE.test(p) && !SKIPPED.test(`/${p}`)).slice(0, MAX_FILES);
    const files: Array<{ path: string; text: string }> = [];
    for (const file of paths) {
      const full = path.join(projectDir, file);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile() || info.size > MAX_FILE) continue;
      files.push({ path: file, text: await readFile(full, 'utf-8') });
    }
    return unloadedStylesheets(sheets, files);
  } catch {
    return [];
  }
}
