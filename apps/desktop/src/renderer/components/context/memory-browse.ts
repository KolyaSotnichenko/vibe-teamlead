/** Filtering the project's memory on the Memories tab. Pure. */

import type { RendererMemory } from '../../../shared/types';

export type MemorySourceFilter = 'all' | 'agent' | 'learned';

export function browseMemories(
  memories: RendererMemory[],
  opts: { source?: MemorySourceFilter; text?: string; category?: (m: RendererMemory) => boolean },
): RendererMemory[] {
  const text = opts.text?.trim().toLowerCase() ?? '';
  return memories.filter((memory) => {
    if (opts.source === 'agent' && memory.source !== 'agent_explicit') return false;
    if (opts.source === 'learned' && memory.source !== 'observer_inferred') return false;
    if (opts.category && !opts.category(memory)) return false;
    if (!text) return true;
    return [memory.content, ...(memory.tags ?? []), ...(memory.relatedFiles ?? [])].some((s) => s.toLowerCase().includes(text));
  });
}
