/**
 * "Run QA again": a fresh review with no changes requested, so no fixer. The
 * request is a marker file the next QA run consumes. No Electron imports.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileReplacingSync } from '../safe-write';

export const QA_RERUN_FILE = 'QA_RERUN';

export function requestQaRerun(specDir: string): void {
  writeFileReplacingSync(join(specDir, QA_RERUN_FILE), new Date().toISOString(), 'utf-8');
  rmSync(join(specDir, 'QA_FIX_REQUEST.md'), { force: true });
}
