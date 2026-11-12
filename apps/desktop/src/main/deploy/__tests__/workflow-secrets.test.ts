import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_WORKFLOW_BYTES, MAX_WORKFLOW_FILES, secretsInWorkflow, workflowSecretNames } from '../workflow-secrets';

let dir: string;
const workflows = () => path.join(dir, '.github', 'workflows');
const write = (name: string, text: string) => {
  mkdirSync(workflows(), { recursive: true });
  writeFileSync(path.join(workflows(), name), text);
};

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wf-secrets-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('secretsInWorkflow', () => {
  it('names every secrets.NAME, upper case, once, without GitHub\'s own', () => {
    const yaml = [
      'env:',
      '  A: ${{ secrets.NPM_TOKEN }}',
      '  B: ${{secrets.stripe_key}}',
      '  C: ${{ secrets.GITHUB_TOKEN }}',
      '  D: ${{ secrets.NPM_TOKEN }}',
      '  E: ${{ env.NOT_A_SECRET }}',
    ].join('\n');
    expect(secretsInWorkflow(yaml)).toEqual(['NPM_TOKEN', 'STRIPE_KEY']);
  });
});

describe('workflowSecretNames', () => {
  it('reads .yml and .yaml files in .github/workflows', async () => {
    write('ci.yml', 'x: ${{ secrets.A_KEY }}');
    write('e2e.yaml', 'x: ${{ secrets.B_KEY }}');
    write('notes.md', 'x: ${{ secrets.C_KEY }}');
    expect((await workflowSecretNames(dir)).sort()).toEqual(['A_KEY', 'B_KEY']);
  });

  it('no workflows folder: none, never throws', async () => {
    expect(await workflowSecretNames(dir)).toEqual([]);
    expect(await workflowSecretNames(path.join(dir, 'missing'))).toEqual([]);
  });

  it('skips files that are too large and symlinks', async () => {
    write('big.yml', `x: \${{ secrets.BIG_KEY }}\n${'#'.repeat(MAX_WORKFLOW_BYTES)}`);
    const outside = path.join(dir, 'outside.yml');
    writeFileSync(outside, 'x: ${{ secrets.LINKED_KEY }}');
    symlinkSync(outside, path.join(workflows(), 'linked.yml'));
    expect(await workflowSecretNames(dir)).toEqual([]);
  });

  it('reads at most a fixed number of files', async () => {
    for (let i = 0; i < MAX_WORKFLOW_FILES + 5; i++) write(`w${String(i).padStart(3, '0')}.yml`, `x: \${{ secrets.K_${i} }}`);
    expect((await workflowSecretNames(dir)).length).toBe(MAX_WORKFLOW_FILES);
  });
});
