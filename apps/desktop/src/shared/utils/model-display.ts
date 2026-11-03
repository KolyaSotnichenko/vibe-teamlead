/**
 * Model display utilities: Claude model shorthands to labels.
 */
import { AVAILABLE_MODELS } from '../constants/models';

/** Human-readable label for a Claude model shorthand (falls back to the raw value). */
export function getModelLabel(model: string): string {
  return AVAILABLE_MODELS.find((m) => m.value === model)?.label ?? model;
}
