import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../claude-code/task', () => ({ READ_TOOLS: ['Read', 'Glob', 'Grep'], runClaudeTask: vi.fn() }));
vi.mock('../../../ipc-handlers/feature-settings-helper', () => ({ getFeatureSettings: () => ({ model: 'opus', thinkingLevel: 'high' }) }));

import { runClaudeTask } from '../../claude-code/task';
import { DesignSystemResultSchema, DirectionsResultSchema, proposeDirections } from '../design-agent';

describe('design agent', () => {
  it('ships its prompt', () => {
    expect(existsSync(path.join(__dirname, '../../../../../prompts/design_system.md'))).toBe(true);
  });

  it('accepts a full system and rejects tokens the QA check could not use', () => {
    const tokens = { colors: [{ name: 'ink', value: '#1C1D19' }], fonts: [{ role: 'body', family: 'Archivo' }], radius: [0], shadows: false };
    expect(DesignSystemResultSchema.safeParse({ markdown: 'x'.repeat(300), tokens }).success).toBe(true);
    expect(DesignSystemResultSchema.safeParse({ markdown: 'x'.repeat(300), tokens: { ...tokens, colors: [{ name: 'p', value: 'purple' }] } }).success).toBe(false);
    expect(DirectionsResultSchema.safeParse({ directions: [] }).success).toBe(false);
  });

  it('asks for directions with the brief, read-only tools and the design-system feature model', async () => {
    const directions = [1, 2, 3].map((i) => ({ id: String(i), name: `D${i}`, summary: 's', palette: [{ name: 'a', value: '#111111' }, { name: 'b', value: '#222222' }, { name: 'c', value: '#333333' }], fonts: [{ role: 'body', family: 'Inter' }], principles: ['p1', 'p2'] }));
    vi.mocked(runClaudeTask).mockResolvedValueOnce({ text: '', output: { directions }, session: {} as never });
    const result = await proposeDirections({ projectPath: '/p', brief: { product: 'A CAD tool for bakers', mood: 'warm' } });
    expect(result.map((d) => d.name)).toEqual(['D1', 'D2', 'D3']);
    const call = vi.mocked(runClaudeTask).mock.calls[0][0];
    expect(call.prompt).toContain('Job: DIRECTIONS.');
    expect(call.prompt).toContain('Product: A CAD tool for bakers');
    // References are a separate section; the brief's field is only the mood
    expect(call.prompt).toContain('Mood: warm');
    expect(call.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(call.model).toBe('opus');
    expect(call.agentType).toBe('design_system');
  });

  it('refuses an empty brief before calling the model', async () => {
    await expect(proposeDirections({ projectPath: '/p', brief: { product: '  ' } })).rejects.toThrow(/Describe the product/);
  });
});
