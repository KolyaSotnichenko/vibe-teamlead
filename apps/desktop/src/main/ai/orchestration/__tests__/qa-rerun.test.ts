import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { QA_RERUN_FILE, requestQaRerun } from '../qa-rerun';

describe('requestQaRerun', () => {
  it('leaves the marker and removes a fix request, which would start the fixer', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vtl-rerun-'));
    writeFileSync(path.join(dir, 'QA_FIX_REQUEST.md'), 'old');
    requestQaRerun(dir);
    expect(existsSync(path.join(dir, QA_RERUN_FILE))).toBe(true);
    expect(existsSync(path.join(dir, 'QA_FIX_REQUEST.md'))).toBe(false);
  });
});
