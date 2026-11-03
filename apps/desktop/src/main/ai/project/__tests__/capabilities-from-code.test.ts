import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectProjectCapabilities } from '../../prompts/prompt-loader';
import { buildProjectIndex } from '../project-indexer';

describe('capabilities from the code (no stored project index)', () => {
  it('sees the Next.js app a task just scaffolded in a pnpm monorepo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caps-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'roadmaply', private: true }));
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web', dependencies: { next: '15.0.0', react: '19.0.0' } }));
    const caps = detectProjectCapabilities(buildProjectIndex(dir) as unknown as Record<string, unknown>);
    expect(caps.is_web_frontend).toBe(true);
  });
});
