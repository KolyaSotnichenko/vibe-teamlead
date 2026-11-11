import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../claude-code/task', () => ({ READ_TOOLS: ['Read', 'Glob', 'Grep'], runClaudeTask: vi.fn() }));
vi.mock('../../../ipc-handlers/feature-settings-helper', () => ({ getFeatureSettings: () => ({ model: 'opus', thinkingLevel: 'high' }) }));

import { runClaudeTask } from '../../claude-code/task';
import { MarkdownResultSchema, packageJobPrompt, writeFromPackage } from '../design-agent';
import type { DesignPackage } from '../package/read-package';

const pkg: DesignPackage = {
  root: 'mhp-global',
  name: 'MHP',
  namespace: 'mhp',
  readme: 'mhp-global/README.md',
  tokenFiles: { css: 'mhp-global/tokens.css' },
  components: [{ name: 'Button', readme: 'mhp-global/components/Button/README.md' }, { name: 'Card' }],
  componentFiles: {},
  logos: ['mhp-global/logos/mark.svg'],
  fonts: [],
  extraReferences: [],
};
const tokens = { colors: [{ name: 'ink', value: '#1C1D19' }], fonts: [{ role: 'body', family: 'Archivo' }], radius: [0], shadows: false };

describe('packageJobPrompt', () => {
  it('names the readme and component readmes, with tokens', () => {
    const p = packageJobPrompt('/proj', '/proj/.vibe-teamlead/design/package', pkg, tokens);
    expect(p.startsWith('Job: PACKAGE.')).toBe(true);
    expect(p).toContain('mhp-global/README.md');
    expect(p).toContain('mhp-global/components/Button/README.md');
    expect(p).toContain('Archivo');
    expect(p).toContain('Return markdown only');
    expect(p).not.toContain('Return markdown and tokens');
  });
  it('asks for tokens when none are known', () => {
    const p = packageJobPrompt('/proj', '/pkg', pkg, undefined);
    expect(p).toContain('Return markdown and tokens');
  });
});

describe('PACKAGE job', () => {
  it('has a prompt section', () => {
    const text = readFileSync(path.join(__dirname, '../../../../../prompts/design_system.md'), 'utf8');
    expect(text).toContain('## PACKAGE');
  });
  it('markdown-only schema rejects short text', () => {
    expect(MarkdownResultSchema.safeParse({ markdown: 'short' }).success).toBe(false);
    expect(MarkdownResultSchema.safeParse({ markdown: 'x'.repeat(200) }).success).toBe(true);
  });
  it('returns the given tokens unchanged', async () => {
    vi.mocked(runClaudeTask).mockResolvedValueOnce({ text: '', output: { markdown: 'x'.repeat(300) }, session: {} as never });
    const r = await writeFromPackage({ projectPath: '/proj', pkgDir: '/pkg', pkg, tokens });
    expect(r.tokens).toBe(tokens);
    expect(vi.mocked(runClaudeTask).mock.calls[0][0].maxTurns).toBe(40);
  });
});
