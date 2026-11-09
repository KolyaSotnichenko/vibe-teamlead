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
const INHERITS_FROM: Partial<Record<FeatureKey, FeatureKey>> = { briefImport: 'roadmap', designSystem: 'roadmap', uxReview: 'designSystem' };

/** Feature model and thinking level for a specific feature runner. */
export function getFeatureSettings(featureKey: FeatureKey): FeatureSettings {
  const settings = readSettingsFile();
  const models = settings?.featureModels as Partial<FeatureModelConfig> | undefined;
  const thinking = settings?.featureThinking as Partial<FeatureThinkingConfig> | undefined;
  // The feature, then what it inherits from, and so on (uxReview → designSystem → roadmap)
  const chain: FeatureKey[] = [featureKey];
  for (let next = INHERITS_FROM[featureKey]; next && !chain.includes(next); next = INHERITS_FROM[next]) chain.push(next);
  const model = chain.map((key) => models?.[key]).find((value) => value !== undefined);
  return {
    model: isUsableModel(model) ? model : DEFAULT_FEATURE_MODELS[featureKey],
    thinkingLevel: chain.map((key) => thinking?.[key]).find((value) => value !== undefined) ?? DEFAULT_FEATURE_THINKING[featureKey],
  };
}
