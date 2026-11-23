/**
 * Dev addresses a project hard-codes in its config, for a service the preview had to run
 * on another port: a Vite proxy to `http://localhost:3000` while the API runs on 55819
 * leaves the page blank with every API call failing. Found by reading the config files
 * frameworks keep such addresses in, never by a model. Pure: no Electron imports, no file
 * access of its own.
 */

import type { PreviewAddressIssue } from '../../shared/types/preview';
import type { PreviewService } from '../../shared/types/project';

interface ProjectFiles {
  /** Tracked files, with `/` */
  files: string[];
  read: (path: string) => string | null;
}

/** A service that runs on another port in the preview than the project expects */
export type DisplacedPorts = Record<string, { ownPort: number; previewPort: number }>;

const CONFIG_FILE = [
  /^(vite|vitest|next|nuxt|astro|svelte)\.config\.[cm]?[jt]s$/,
  /^webpack[\w.-]*\.[cm]?[jt]s$/,
  /^angular\.json$/,
  /^proxy\.conf\.(json|[cm]?[jt]s)$/,
  /^package\.json$/,
];

const LOCAL_ADDRESS = /(?:(?:https?|wss?):\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g;
const COMMENT = /^\s*(\/\/|\/\*|\*|#)/;

/** The service's config files: in its folder or its `src/` */
function configFiles(service: PreviewService, files: string[]): string[] {
  const prefix = service.dir ? `${service.dir}/` : '';
  return files.filter((file) => {
    if (!file.startsWith(prefix)) return false;
    const rest = file.slice(prefix.length);
    const name = rest.startsWith('src/') ? rest.slice(4) : rest;
    if (name.includes('/')) return false;
    return CONFIG_FILE.some((pattern) => pattern.test(name)) && !(rest.startsWith('src/') && name === 'package.json');
  });
}

/** package.json: only its `proxy` field (Create React App) */
const relevantLine = (file: string, line: string) => !file.endsWith('package.json') || /^\s*"proxy"\s*:/.test(line);

export function findHardcodedAddresses(services: PreviewService[], project: ProjectFiles, displaced: DisplacedPorts): PreviewAddressIssue[] {
  const byPort = new Map(Object.entries(displaced).map(([name, ports]) => [ports.ownPort, { name, ...ports }]));
  if (!byPort.size) return [];
  const issues: PreviewAddressIssue[] = [];
  const seen = new Set<string>();
  for (const from of services) {
    for (const file of configFiles(from, project.files)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const lines = (project.read(file) ?? '').split('\n');
      lines.forEach((line, index) => {
        if (COMMENT.test(line) || !relevantLine(file, line)) return;
        for (const match of line.matchAll(LOCAL_ADDRESS)) {
          const target = byPort.get(Number(match[1]));
          if (!target || target.name === from.name) continue;
          issues.push({ service: target.name, from: from.name, fromDir: from.dir, file, line: index + 1, address: match[0], ownPort: target.ownPort, previewPort: target.previewPort });
        }
      });
    }
  }
  return issues;
}

const PROXY_KEY = /['"]\^?(\/[\w\-./]*)[^'"]*['"]\s*:/g;
const REWRITE_SOURCE = /\bsource\s*:\s*['"](\/[\w\-./]*)/g;

/** Paths the page's dev server sends on to a backend: its proxy keys and rewrite sources, else `/api`. At most three. */
export function proxiedPaths(page: PreviewService, project: ProjectFiles): string[] {
  const paths = new Set<string>();
  for (const file of configFiles(page, project.files)) {
    if (file.endsWith('package.json')) continue;
    const text = project.read(file) ?? '';
    if (!/proxy|rewrites/.test(text)) continue;
    for (const match of [...text.matchAll(PROXY_KEY), ...text.matchAll(REWRITE_SOURCE)]) {
      const path = match[1].replace(/\/+$/, '').replace(/\/\.$/, '');
      if (path && path !== '/') paths.add(path);
    }
  }
  return paths.size ? [...paths].slice(0, 3) : ['/api'];
}
