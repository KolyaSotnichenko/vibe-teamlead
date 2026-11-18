/**
 * Whether a task concerns cloud infrastructure: only then does the architect get
 * TerraVision (its MCP server and a prompt section). A cheap word match, no model
 * call, so ordinary tasks pay nothing for the feature. Pure apart from the
 * bounded folder scan; no Electron: the worker uses it.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CLOUD_DESIGN_MARKER } from '../../../shared/types/cloud-architecture';

export { CLOUD_DESIGN_MARKER };

/** Names a cloud, Terraform or infrastructure as code: enough on its own. */
const STRONG = new RegExp(
  [
    '\\bterraform\\b', '\\bopentofu\\b', '\\.tf\\b', '\\.tfvars\\b', '\\binfrastructure[- ]as[- ]code\\b', '\\biac\\b',
    '\\baws\\b', '\\bamazon web services\\b', '\\bazure\\b', '\\bentra id\\b', '\\bgcp\\b', '\\bgoogle cloud\\b',
    '\\bs3\\b', '\\bdynamodb\\b', '\\bcloudfront\\b', '\\becs\\b', '\\beks\\b', '\\baks\\b', '\\bgke\\b',
    '\\bcloud run\\b', '\\bapp service\\b', '\\bvpc\\b', '\\bvnet\\b', '\\bsubnets?\\b', '\\bkubernetes\\b',
    '\\bcloud (infrastructure|architecture|provider|deployment)\\b',
  ].join('|'),
  'i',
);

/** About deployment or infrastructure: counts only in a project that has Terraform. */
const WEAK = /\b(deploy(s|ed|ing|ment)?|infrastructure|hosting|hosted|environments?|staging|production|regions?|scal(e|ing)|load balancer|cdn|networking|cloud)\b/i;

export function concernsCloudInfra(input: { text: string; projectHasTerraform: boolean }): boolean {
  const { text, projectHasTerraform } = input;
  if (text.includes(CLOUD_DESIGN_MARKER)) return true;
  if (STRONG.test(text)) return true;
  return projectHasTerraform && WEAK.test(text);
}

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'venv']);

/** The project's .tf files (relative paths), a few levels deep; hidden and dependency folders skipped. */
export function findTerraformFiles(root: string, maxDepth = 4, limit = 50, pattern: RegExp = /\.tf$/i): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const relPath = rel ? join(rel, entry.name) : entry.name;
      if (entry.isFile() && pattern.test(entry.name)) found.push(relPath);
      else if (entry.isDirectory() && depth < maxDepth && !entry.name.startsWith('.') && !SKIP.has(entry.name)) {
        walk(join(dir, entry.name), relPath, depth + 1);
      }
    }
  };
  walk(root, '', 0);
  return found.sort();
}
