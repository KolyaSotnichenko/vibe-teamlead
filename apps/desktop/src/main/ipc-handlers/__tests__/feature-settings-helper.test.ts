import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readSettingsFile } = vi.hoisted(() => ({ readSettingsFile: vi.fn() }));
vi.mock('../../settings-utils', () => ({ readSettingsFile }));

import { getFeatureSettings } from '../feature-settings-helper';

describe('getFeatureSettings', () => {
  beforeEach(() => readSettingsFile.mockReset());

  it('uses the saved model, including non-Claude ids', () => {
    readSettingsFile.mockReturnValue({ featureModels: { briefImport: 'qwen3-coder:480b-cloud' }, featureThinking: { briefImport: 'medium' } });
    expect(getFeatureSettings('briefImport')).toEqual({ model: 'qwen3-coder:480b-cloud', thinkingLevel: 'medium' });
  });

  it('spec import reads the roadmap choice until it has its own', () => {
    readSettingsFile.mockReturnValue({ featureModels: { roadmap: 'gpt-oss:120b' }, featureThinking: { roadmap: 'low' } });
    expect(getFeatureSettings('briefImport')).toEqual({ model: 'gpt-oss:120b', thinkingLevel: 'low' });
  });

  it('falls back to the defaults', () => {
    readSettingsFile.mockReturnValue({});
    expect(getFeatureSettings('briefImport')).toEqual({ model: 'opus', thinkingLevel: 'high' });
    readSettingsFile.mockReturnValue({ featureModels: { utility: 'gpt-5.2' } });
    expect(getFeatureSettings('utility').model).toBe('haiku');
  });

  it("the UX review reads the design system's choice, and through it the roadmap's, until it has its own", () => {
    readSettingsFile.mockReturnValue({ featureModels: { roadmap: 'gpt-oss:120b' }, featureThinking: { roadmap: 'low' } });
    expect(getFeatureSettings('uxReview')).toEqual({ model: 'gpt-oss:120b', thinkingLevel: 'low' });
    readSettingsFile.mockReturnValue({ featureModels: { roadmap: 'a', designSystem: 'b' }, featureThinking: { designSystem: 'high' } });
    expect(getFeatureSettings('uxReview')).toEqual({ model: 'b', thinkingLevel: 'high' });
    readSettingsFile.mockReturnValue({ featureModels: { designSystem: 'b', uxReview: 'c' } });
    expect(getFeatureSettings('uxReview').model).toBe('c');
  });
});
