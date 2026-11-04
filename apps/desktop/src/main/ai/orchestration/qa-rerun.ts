/**
 * "Run QA again": a fresh review with no changes requested, so no fixer. The
 * request is a marker file the next QA run consumes. No Electron imports.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const QA_RERUN_FILE = 'QA_RERUN';

export function requestQaRerun(specDir: string): void {
  writeFileSync(join(specDir, QA_RERUN_FILE), new Date().toISOString(), 'utf-8');
  rmSync(join(specDir, 'QA_FIX_REQUEST.md'), { force: true });
}
