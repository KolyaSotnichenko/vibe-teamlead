/**
 * Project memory for the agent pipeline (main process only).
 *
 * - After each coder session, what it learned (gotchas, patterns, per-file
 *   insights, a failed approach) is stored for the project.
 * - Before an agent starts, the memories most relevant to its task are put in
 *   its prompt; during the session it can search and add memories with tools.
 *
 * Workers reach this through the bridge (`memory-request` messages). Memory is
 * best-effort: any failure returns nothing and never blocks an agent.
 * Off when the user turned memory off (Settings → Memory, `memoryEnabled: false`).
 */

import { getMemoryService } from '../../ipc-handlers/context/memory-service-factory';
import { readSettingsFile } from '../../settings-utils';
import type { ExtractedInsights } from '../runners/insight-extractor';
import type { Memory, MemoryRecordEntry, MemoryType } from './types';

/** Memory entries one session may add (keeps a chatty extraction from flooding the store) */
const MAX_PER_SESSION = 12;
const MAX_CONTENT_CHARS = 600;

/** Types an agent may store with the remember tool */
export const AGENT_MEMORY_TYPES = ['gotcha', 'decision', 'pattern', 'module_insight', 'error_pattern', 'requirement'] as const;
export type AgentMemoryType = (typeof AGENT_MEMORY_TYPES)[number];

export interface MemoryTaskRef {
  projectId: string;
  /** Spec id of the task (memory tags and provenance) */
  specId?: string;
}

export function isMemoryEnabled(settings: { memoryEnabled?: unknown } | null | undefined = readSettings()): boolean {
  return settings?.memoryEnabled !== false;
}

function readSettings(): { memoryEnabled?: unknown } | undefined {
  try {
    return readSettingsFile() as { memoryEnabled?: unknown } | undefined;
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > MAX_CONTENT_CHARS ? `${trimmed.slice(0, MAX_CONTENT_CHARS - 1)}…` : trimmed;
}

/** Memory entries for what one coder session learned. Pure — tested directly. */
export function insightsToEntries(ref: MemoryTaskRef, insights: ExtractedInsights): MemoryRecordEntry[] {
  const tags = [ref.specId, insights.subtask_id ? `subtask:${insights.subtask_id}` : undefined].filter(
    (t): t is string => !!t,
  );
  const files = insights.changed_files ?? [];
  const base = {
    projectId: ref.projectId,
    source: 'observer_inferred' as const,
    scope: 'global' as const,
    tags,
    ...(ref.specId
      ? { workUnitRef: { methodology: 'native', hierarchy: [ref.specId, insights.subtask_id].filter(Boolean), label: ref.specId } }
      : {}),
  };
  const entries: MemoryRecordEntry[] = [];
  const add = (type: MemoryType, content: string | null | undefined, relatedFiles: string[], confidence: number) => {
    const text = content ? clip(content) : '';
    if (text.length < 12 || entries.some((e) => e.content === text)) return;
    entries.push({ ...base, type, content: text, relatedFiles, confidence });
  };

  for (const gotcha of insights.gotchas_discovered ?? []) add('gotcha', gotcha, files, 0.75);
  for (const pattern of insights.patterns_discovered ?? []) add('pattern', pattern, files, 0.7);
  for (const item of insights.file_insights ?? []) {
    if (item?.file && item.insight) add('module_insight', `${item.file}: ${item.insight}`, [item.file], 0.7);
  }
  const outcome = insights.approach_outcome;
  if (outcome && !outcome.success && outcome.approach_used && outcome.why_it_failed) {
    add('error_pattern', `Did not work: ${outcome.approach_used} — ${outcome.why_it_failed}`, files, 0.65);
  }
  return entries.slice(0, MAX_PER_SESSION);
}

/** Store what a coder session learned; returns how many memories were added. */
export async function recordSessionInsights(ref: MemoryTaskRef, insights: ExtractedInsights): Promise<number> {
  if (!isMemoryEnabled()) return 0;
  const entries = insightsToEntries(ref, insights);
  if (!entries.length) return 0;
  const service = await getMemoryService();
  let stored = 0;
  for (const entry of entries) {
    try {
      await service.store(entry);
      stored++;
    } catch {
      // Skip this one; memory is best-effort
    }
  }
  return stored;
}

/** Store one memory an agent chose to keep (remember tool). */
export async function rememberForAgent(
  ref: MemoryTaskRef,
  input: { type: AgentMemoryType; content: string; files?: string[] },
): Promise<string> {
  if (!isMemoryEnabled()) throw new Error('Memory is turned off in Settings');
  const content = clip(input.content);
  if (content.length < 12) throw new Error('Say a bit more: the memory is too short to be useful');
  const service = await getMemoryService();
  return service.store({
    type: input.type,
    content,
    projectId: ref.projectId,
    relatedFiles: input.files ?? [],
    tags: ref.specId ? [ref.specId] : [],
    source: 'agent_explicit',
    scope: 'global',
    confidence: 0.8,
  });
}

/** The project's memories most relevant to a query. */
export async function searchProjectMemory(projectId: string, query: string, limit = 8): Promise<Memory[]> {
  if (!isMemoryEnabled() || !query.trim()) return [];
  const service = await getMemoryService();
  return service.search({ query: query.slice(0, 2000), projectId, limit, excludeDeprecated: true, sort: 'relevance' });
}

/** One line per memory, for prompts and tool results. Pure — tested directly. */
export function formatMemories(memories: Memory[]): string {
  return memories
    .map((m) => {
      const files = m.relatedFiles?.length ? ` (files: ${m.relatedFiles.slice(0, 4).join(', ')})` : '';
      return `- [${m.type}] ${m.content}${files}`;
    })
    .join('\n');
}

/** Prompt section with the memories relevant to a task, or '' when there are none. */
export async function memoryPromptSection(projectId: string, query: string, limit = 8): Promise<string> {
  const memories = await searchProjectMemory(projectId, query, limit);
  if (!memories.length) return '';
  return [
    '## Project memory',
    '',
    'What agents learned in earlier work on this project, most relevant first. Treat these as hints:',
    'check them against the code before relying on them, and ignore any that no longer hold.',
    'If you have the `search_memory` and `remember` tools, use them to look further and to keep what the next agent should know.',
    '',
    formatMemories(memories),
  ].join('\n');
}
