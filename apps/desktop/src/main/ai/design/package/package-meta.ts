/**
 * What the project knows about its imported design package: where it lives, which
 * components it holds, and which of them the project has already built. Kept in the app's
 * folder of the project, next to the system meta.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { DesignPackageInfo } from '../../../../shared/types';
import { writeFileReplacingSync } from '../../safe-write';

export const PACKAGE_DIR = '.vibe-teamlead/design/package';

const metaFile = (projectPath: string) => path.join(projectPath, '.vibe-teamlead', 'design', 'package-meta.json');

const COMPONENT_ROOTS = ['apps/web/src/components', 'src/components', 'components', 'app/components'];

/** Where rebuilt components go: the project's components folder plus the package namespace. */
export function componentsDirFor(projectPath: string, namespace: string): string {
  const isDir = (rel: string) => {
    try {
      return statSync(path.join(projectPath, rel)).isDirectory();
    } catch {
      return false;
    }
  };
  const root = COMPONENT_ROOTS.find(isDir) ?? 'src/components';
  return `${root}/${namespace.toLowerCase()}`;
}

export function writePackageMeta(projectPath: string, info: DesignPackageInfo): void {
  mkdirSync(path.dirname(metaFile(projectPath)), { recursive: true });
  writeFileReplacingSync(metaFile(projectPath), `${JSON.stringify(info, null, 2)}\n`, 'utf-8');
}

export function readPackageMeta(projectPath: string): DesignPackageInfo | undefined {
  try {
    const raw = JSON.parse(readFileSync(metaFile(projectPath), 'utf-8')) as Partial<DesignPackageInfo>;
    if (typeof raw.name !== 'string' || typeof raw.namespace !== 'string' || typeof raw.dir !== 'string' || typeof raw.componentsDir !== 'string') {
      return undefined;
    }
    return { ...raw, themes: raw.themes === 'light-dark' ? 'light-dark' : 'light' } as DesignPackageInfo;
  } catch {
    return undefined;
  }
}

/** The components whose folder already exists under the components folder. */
export function builtComponents(cwd: string, componentsDir: string, names: string[]): string[] {
  return names.filter((name) => existsSync(path.join(cwd, componentsDir, name)));
}
