import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => tmpdir() } }));

import { projectLooseEnds } from '../loose-ends-handlers';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vtl-loose-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

describe('projectLooseEnds', () => {
  it("finds placeholders in the files git tracks, and leaves out the ones the owner ignored", async () => {
    const root = repo({ 'app/page.tsx': '<p>Placeholder home page</p>', 'app/billing/page.tsx': '<p>Coming soon</p>' });
    writeFileSync(join(root, 'untracked.tsx'), '<p>Coming soon</p>');
    expect((await projectLooseEnds(root, [])).map((e) => e.file)).toEqual(['app/billing/page.tsx', 'app/page.tsx']);
    expect((await projectLooseEnds(root, ['app/billing/page.tsx\n<p>Coming soon</p>'])).map((e) => e.file)).toEqual(['app/page.tsx']);
  });
});
