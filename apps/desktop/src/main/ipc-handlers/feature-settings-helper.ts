/**
 * Feature Settings Helper
 *
 * Reads feature settings (Claude model + thinking level) for feature runners
 * like Insights, Ideation, Roadmap and naming.
 *
 * Resolution order:
 * 1. settings.featureModels[featureKey] / settings.featureThinking[featureKey]
 * 2. DEFAULT_FEATURE_MODELS[featureKey] / DEFAULT_FEATURE_THINKING[featureKey]
 *
 * A stored model of a removed (non-Claude) provider falls back to the default.
 */

import { isUsableModel } from '../ai/config/phase-config';
import { readSettingsFile } from '../settings-utils';
import { DEFAULT_FEATURE_MODELS, DEFAULT_FEATURE_THINKING } from '../../shared/constants/models';
import type { FeatureModelConfig, FeatureThinkingConfig } from '../../shared/types/settings';

type FeatureKey = keyof FeatureModelConfig;

interface FeatureSettings {
  model: string;
  thinkingLevel: string;
}

/**
 * A feature added later reads a related feature's saved choice until the user
 * picks one, so a model chosen before it existed (e.g. an Ollama model) applies.
 */
const INHERITS_FROM: Partial<Record<FeatureKey, FeatureKey>> = { briefImport: 'roadmap', designSystem: 'roadmap' };

/** Feature model and thinking level for a specific feature runner. */
export function getFeatureSettings(featureKey: FeatureKey): FeatureSettings {
  const settings = readSettingsFile();
  const models = settings?.featureModels as Partial<FeatureModelConfig> | undefined;
  const thinking = settings?.featureThinking as Partial<FeatureThinkingConfig> | undefined;
  const inherited = INHERITS_FROM[featureKey];
  const model = models?.[featureKey] ?? (inherited ? models?.[inherited] : undefined);
  return {
    model: isUsableModel(model) ? model : DEFAULT_FEATURE_MODELS[featureKey],
    thinkingLevel:
      thinking?.[featureKey] ?? (inherited ? thinking?.[inherited] : undefined) ?? DEFAULT_FEATURE_THINKING[featureKey],
  };
}
