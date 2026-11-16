import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

vi.mock('../cli-tool-manager', () => ({ getToolPath: () => 'git' }));
// The exclude file could not be written (it never throws): the first commit must still leave the folder out
vi.mock('../utils/git-exclude', () => ({ excludeFromGit: vi.fn() }));

import { initializeProject } from '../project-initializer';

it('makes no first commit when the exclude file was not written, instead of committing .vibe-teamlead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtl-init-'));
  writeFileSync(join(dir, 'README.md'), '# app\n');
  const result = initializeProject(dir);
  expect(result.success).toBe(false);
  expect(result.error).toContain('.vibe-teamlead/');
  const files = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf-8' });
  expect(files).not.toContain('.vibe-teamlead');
});
