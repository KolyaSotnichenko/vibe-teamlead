/**
 * The models a task runs with when nothing more specific was chosen: the
 * selected agent profile (Settings → Agents), with the user's custom phase
 * models and thinking levels over it. The task wizard shows exactly this; tasks
 * created without the wizard (spec document import) get it written into their
 * metadata, so every phase — and every helper call — uses what the user set.
 */
import { DEFAULT_AGENT_PROFILES, DEFAULT_PHASE_MODELS, DEFAULT_PHASE_THINKING } from '../constants/models';
import type { PhaseModelConfig, PhaseThinkingConfig, ThinkingLevel } from '../types/settings';

export interface DefaultTaskModels {
  isAutoProfile: true;
  model: string;
  thinkingLevel: ThinkingLevel;
  phaseModels: PhaseModelConfig;
  phaseThinking: PhaseThinkingConfig;
}

interface ModelSettings {
  selectedAgentProfile?: string;
  customPhaseModels?: PhaseModelConfig;
  customPhaseThinking?: PhaseThinkingConfig;
}

export function resolveDefaultTaskModels(settings: ModelSettings | null | undefined): DefaultTaskModels {
  const profile =
    DEFAULT_AGENT_PROFILES.find((p) => p.id === (settings?.selectedAgentProfile ?? 'auto')) ??
    DEFAULT_AGENT_PROFILES.find((p) => p.id === 'auto') ??
    DEFAULT_AGENT_PROFILES[0];
  const phaseModels = { ...DEFAULT_PHASE_MODELS, ...(profile.phaseModels ?? {}), ...(settings?.customPhaseModels ?? {}) };
  const phaseThinking = { ...DEFAULT_PHASE_THINKING, ...(profile.phaseThinking ?? {}), ...(settings?.customPhaseThinking ?? {}) };
  return {
    isAutoProfile: true,
    model: phaseModels.coding,
    thinkingLevel: phaseThinking.coding,
    phaseModels,
    phaseThinking,
  };
}
