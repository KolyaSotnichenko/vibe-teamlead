import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readSettingsFile } = vi.hoisted(() => ({ readSettingsFile: vi.fn() }));
vi.mock('../../settings-utils', () => ({ readSettingsFile }));

import { resolveDefaultTaskModels } from '../../../shared/utils/task-models';
import { ensureTaskModels, hasTaskModels, withDefaultTaskModels } from '../task-models';

const ollama = { spec: 'qwen3-coder:480b-cloud', planning: 'qwen3-coder:480b-cloud', coding: 'gpt-oss:120b', qa: 'qwen3-coder:480b-cloud' };

describe('resolveDefaultTaskModels', () => {
  it("uses the user's custom phase models over the profile", () => {
    const models = resolveDefaultTaskModels({ selectedAgentProfile: 'balanced', customPhaseModels: ollama });
    expect(models.phaseModels).toEqual(ollama);
    expect(models.model).toBe('gpt-oss:120b');
    expect(models.phaseThinking.coding).toBe('medium');
  });

  it('falls back to the auto profile', () => {
    expect(resolveDefaultTaskModels(undefined).phaseModels.spec).toBe('opus');
  });
});

describe('task metadata models', () => {
  beforeEach(() => readSettingsFile.mockReset());

  it('treats metadata without usable models as missing', () => {
    expect(hasTaskModels({})).toBe(false);
    expect(hasTaskModels({ isAutoProfile: true, phaseModels: { spec: 'gpt-5.2' } })).toBe(false);
    expect(hasTaskModels({ isAutoProfile: true, phaseModels: ollama })).toBe(true);
    expect(hasTaskModels({ model: 'sonnet' })).toBe(true);
  });

  it('keeps models a task already chose', () => {
    const metadata = { isAutoProfile: true, phaseModels: { spec: 'opus', planning: 'opus', coding: 'sonnet', qa: 'haiku' } };
    expect(withDefaultTaskModels(metadata, { customPhaseModels: ollama })).toBe(metadata);
  });

  it('writes the defaults into a task that has none (spec document import)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-models-'));
    writeFileSync(join(dir, 'task_metadata.json'), JSON.stringify({ sourceType: 'brief', briefId: 'b1' }));
    readSettingsFile.mockReturnValue({ customPhaseModels: ollama });

    ensureTaskModels(dir);

    const written = JSON.parse(readFileSync(join(dir, 'task_metadata.json'), 'utf-8'));
    expect(written.sourceType).toBe('brief');
    expect(written.isAutoProfile).toBe(true);
    expect(written.phaseModels.spec).toBe('qwen3-coder:480b-cloud');
    expect(written.phaseModels.coding).toBe('gpt-oss:120b');
  });
});
