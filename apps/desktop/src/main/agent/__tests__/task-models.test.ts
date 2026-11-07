import { lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readSettingsFile } = vi.hoisted(() => ({ readSettingsFile: vi.fn() }));
vi.mock('../../settings-utils', () => ({ readSettingsFile }));

import { modelsChosenAfterEdit, modelsDifferFromDefaults, resolveDefaultTaskModels } from '../../../shared/utils/task-models';
import { copyTaskModels, ensureTaskModels, hasChosenModels, withDefaultTaskModels } from '../task-models';

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

  it('counts models as chosen only when the user picked them', () => {
    expect(hasChosenModels({})).toBe(false);
    expect(hasChosenModels({ isAutoProfile: true, phaseModels: ollama })).toBe(false);
    expect(hasChosenModels({ isAutoProfile: true, modelsChosen: true, phaseModels: { spec: 'gpt-5.2' } })).toBe(false);
    expect(hasChosenModels({ isAutoProfile: true, modelsChosen: true, phaseModels: ollama })).toBe(true);
    expect(hasChosenModels({ model: 'sonnet' })).toBe(true);
  });

  it('keeps models the user picked for this task', () => {
    const metadata = { isAutoProfile: true, modelsChosen: true, phaseModels: { spec: 'opus', planning: 'opus', coding: 'sonnet', qa: 'haiku' } };
    expect(withDefaultTaskModels(metadata, { customPhaseModels: ollama })).toBe(metadata);
  });

  it('moves a task that only took the defaults to the current settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-models-'));
    writeFileSync(join(dir, 'task_metadata.json'), JSON.stringify({
      sourceType: 'manual', isAutoProfile: true, model: 'kimi', thinkingLevel: 'high',
      phaseModels: { spec: 'kimi', planning: 'kimi', coding: 'kimi', qa: 'kimi' },
      phaseThinking: { spec: 'high', planning: 'high', coding: 'high', qa: 'high' },
    }));
    readSettingsFile.mockReturnValue({ customPhaseModels: ollama, customPhaseThinking: { spec: 'low', planning: 'low', coding: 'low', qa: 'low' } });

    ensureTaskModels(dir);

    const written = JSON.parse(readFileSync(join(dir, 'task_metadata.json'), 'utf-8'));
    expect(written.sourceType).toBe('manual');
    expect(written.phaseModels).toEqual(ollama);
    expect(written.model).toBe('gpt-oss:120b');
    expect(written.phaseThinking.qa).toBe('low');
    expect(written.thinkingLevel).toBe('low');
  });

  it('leaves the task as it is when the settings cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-models-'));
    const before = JSON.stringify({ isAutoProfile: true, phaseModels: ollama });
    writeFileSync(join(dir, 'task_metadata.json'), before);
    readSettingsFile.mockReturnValue(undefined);

    ensureTaskModels(dir);

    expect(readFileSync(join(dir, 'task_metadata.json'), 'utf-8')).toBe(before);
  });

  it("doesn't rewrite a task already on the current settings", () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-models-'));
    const file = join(dir, 'task_metadata.json');
    readSettingsFile.mockReturnValue({ customPhaseModels: ollama });
    writeFileSync(file, '{}');
    ensureTaskModels(dir);
    const old = new Date(1_000_000);
    utimesSync(file, old, old);

    ensureTaskModels(dir);

    expect(statSync(file).mtimeMs).toBe(old.getTime());
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

describe('a task folder and its worktree copy', () => {
  function dirWith(metadata: object): string {
    const dir = mkdtempSync(join(tmpdir(), 'task-models-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'task_metadata.json'), JSON.stringify(metadata));
    return dir;
  }
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'task_metadata.json'), 'utf-8'));

  it('gives the copy the models, the only ones a running task reads', () => {
    const from = dirWith({ isAutoProfile: true, modelsChosen: true, model: 'sonnet', thinkingLevel: 'low', phaseModels: ollama, phaseThinking: { qa: 'low' } });
    const to = dirWith({ sourceType: 'manual', isAutoProfile: true, model: 'kimi', phaseModels: { qa: 'kimi' } });

    copyTaskModels(from, to);

    expect(read(to)).toEqual({ sourceType: 'manual', isAutoProfile: true, modelsChosen: true, model: 'sonnet', thinkingLevel: 'low', phaseModels: ollama, phaseThinking: { qa: 'low' } });
  });

  it('clears a choice the user took back', () => {
    const from = dirWith({ isAutoProfile: true, phaseModels: ollama });
    const to = dirWith({ isAutoProfile: true, modelsChosen: true, phaseModels: ollama });

    copyTaskModels(from, to);

    expect(read(to).modelsChosen).toBeUndefined();
  });

  it('does nothing without a copy: the task has no worktree yet', () => {
    const from = dirWith({ phaseModels: ollama });
    const missing = join(from, 'nope');
    expect(() => copyTaskModels(from, missing)).not.toThrow();
  });
});

describe('whether the user chose a task\'s models', () => {
  const thinking = { spec: 'high', planning: 'high', coding: 'low', qa: 'low' } as const;
  const settings = { customPhaseModels: ollama, customPhaseThinking: thinking };

  it('is no when the form still shows the settings', () => {
    expect(modelsDifferFromDefaults({ phaseModels: ollama, phaseThinking: thinking }, settings)).toBe(false);
  });

  it('is yes when a model or a thinking level differs', () => {
    expect(modelsDifferFromDefaults({ phaseModels: { ...ollama, qa: 'sonnet' }, phaseThinking: thinking }, settings)).toBe(true);
    expect(modelsDifferFromDefaults({ phaseModels: ollama, phaseThinking: { ...thinking, qa: 'high' } }, settings)).toBe(true);
  });

  it('saving a title keeps a following task following, though its models look old', () => {
    const old = { phaseModels: { ...ollama, qa: 'kimi' }, phaseThinking: thinking };
    expect(modelsChosenAfterEdit(old, old, settings)).toBe(false);
  });

  it('saving a title keeps a choice', () => {
    const chosen = { modelsChosen: true, phaseModels: { ...ollama, qa: 'kimi' }, phaseThinking: thinking };
    expect(modelsChosenAfterEdit(chosen, chosen, settings)).toBe(true);
  });

  it('changing a model in the dialog is a choice, and setting it back to the settings ends it', () => {
    const before = { phaseModels: ollama, phaseThinking: thinking };
    const changed = { phaseModels: { ...ollama, qa: 'sonnet' }, phaseThinking: thinking };
    expect(modelsChosenAfterEdit(before, changed, settings)).toBe(true);
    expect(modelsChosenAfterEdit({ ...changed, modelsChosen: true }, before, settings)).toBe(false);
  });
});

describe('a link an agent left in place of the metadata', () => {
  const OUTSIDE = '{"secret":"stays"}';
  function linkedDir(): { dir: string; outside: string } {
    const dir = mkdtempSync(join(tmpdir(), 'task-models-'));
    const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'settings.json');
    writeFileSync(outside, OUTSIDE);
    symlinkSync(outside, join(dir, 'task_metadata.json'));
    return { dir, outside };
  }

  it('is replaced by a real file when the models are set, and what it points at stays', () => {
    const { dir, outside } = linkedDir();
    readSettingsFile.mockReturnValue({ customPhaseModels: ollama });

    ensureTaskModels(dir);

    expect(readFileSync(outside, 'utf-8')).toBe(OUTSIDE);
    expect(lstatSync(join(dir, 'task_metadata.json')).isSymbolicLink()).toBe(false);
    const written = JSON.parse(readFileSync(join(dir, 'task_metadata.json'), 'utf-8'));
    expect(written.secret).toBeUndefined();
    expect(written.phaseModels).toEqual(ollama);
  });

  it('is replaced when models are copied to a worktree, and what it points at stays', () => {
    const { dir, outside } = linkedDir();
    const from = mkdtempSync(join(tmpdir(), 'task-models-'));
    writeFileSync(join(from, 'task_metadata.json'), JSON.stringify({ isAutoProfile: true, phaseModels: ollama }));

    copyTaskModels(from, dir);

    expect(readFileSync(outside, 'utf-8')).toBe(OUTSIDE);
    expect(lstatSync(join(dir, 'task_metadata.json')).isSymbolicLink()).toBe(false);
    const written = JSON.parse(readFileSync(join(dir, 'task_metadata.json'), 'utf-8'));
    expect(written.secret).toBeUndefined();
    expect(written.phaseModels).toEqual(ollama);
  });

  it('is not read as the source of a copy', () => {
    const { dir: from } = linkedDir();
    const to = mkdtempSync(join(tmpdir(), 'task-models-'));
    const before = JSON.stringify({ phaseModels: ollama });
    writeFileSync(join(to, 'task_metadata.json'), before);

    copyTaskModels(from, to);

    expect(readFileSync(join(to, 'task_metadata.json'), 'utf-8')).toBe(before);
  });
});
