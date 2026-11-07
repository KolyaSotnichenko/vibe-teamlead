/**
 * The models a task runs with unless the user picked others for it: the
 * selected agent profile (Settings → Agents), with the user's custom phase
 * models and thinking levels over it. The task wizard shows exactly this. Before
 * each run it is written into the metadata of a task the user picked nothing
 * for, so every phase — and every helper call — uses what is set now.
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

interface TaskModelChoice {
  modelsChosen?: boolean;
  phaseModels?: PhaseModelConfig;
  phaseThinking?: PhaseThinkingConfig;
}

const sameValues = (a: object | undefined, b: object): boolean =>
  Object.entries(b).every(([phase, value]) => (a as Record<string, unknown> | undefined)?.[phase] === value);

/** Whether a task form's models are the user's own pick rather than the settings. */
export function modelsDifferFromDefaults(chosen: TaskModelChoice, settings: ModelSettings | null | undefined): boolean {
  const defaults = resolveDefaultTaskModels(settings);
  return !sameValues(chosen.phaseModels, defaults.phaseModels) || !sameValues(chosen.phaseThinking, defaults.phaseThinking);
}

/**
 * Whether a task counts as picked by the user after its edit dialog is saved.
 * A task following the settings can show old models until its next run, so only
 * a real change in the dialog decides anything.
 */
export function modelsChosenAfterEdit(before: TaskModelChoice, after: TaskModelChoice, settings: ModelSettings | null | undefined): boolean {
  const unchanged =
    JSON.stringify(before.phaseModels) === JSON.stringify(after.phaseModels) &&
    JSON.stringify(before.phaseThinking) === JSON.stringify(after.phaseThinking);
  return unchanged ? before.modelsChosen === true : modelsDifferFromDefaults(after, settings);
}
