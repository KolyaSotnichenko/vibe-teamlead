/**
 * Whether a task animates with GSAP: the project (or a workspace package) depends on it, or the
 * task's design uses it. UI coders of such a task get GreenSock's GSAP skills.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PACKAGE_DIRS = ['', 'apps', 'packages'];

function dependsOnGsap(file: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, Record<string, string> | undefined>;
    return ['dependencies', 'devDependencies'].some((key) => Object.keys(pkg[key] ?? {}).some((name) => name === 'gsap' || name.startsWith('@gsap/')));
  } catch {
    return false;
  }
}

function packageFiles(projectDir: string): string[] {
  const files = [path.join(projectDir, 'package.json')];
  for (const dir of PACKAGE_DIRS.filter(Boolean)) {
    const full = path.join(projectDir, dir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(path.join(full, entry.name, 'package.json'));
    }
  }
  return files.filter((file) => existsSync(file));
}

function designUsesGsap(specDir: string): boolean {
  const dir = path.join(specDir, 'design', 'screens');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((file) => file.endsWith('.html') && /\bgsap\b/.test(readFileSync(path.join(dir, file), 'utf-8')));
}

export function animatesWithGsap(projectDir: string, specDir?: string): boolean {
  return packageFiles(projectDir).some(dependsOnGsap) || (!!specDir && designUsesGsap(specDir));
}
