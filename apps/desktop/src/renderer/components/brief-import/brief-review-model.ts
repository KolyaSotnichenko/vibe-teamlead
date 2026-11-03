/**
 * Pure logic behind the review step of brief import: which dependencies are
 * lost when tasks are left out, the order tasks can start in ("waves"), and
 * the payload sent to `brief.createTasks`. Kept free of React for tests.
 */

import type { BriefEpic, BriefTaskDraft } from '../../../shared/types';

/** File types the brief analyst can read. */
export const BRIEF_FILE_EXTENSIONS = ['.md', '.markdown', '.txt', '.pdf', '.docx', '.rtf', '.odt'] as const;

export function isSupportedBriefFile(name: string): boolean {
  const lower = name.toLowerCase();
  return BRIEF_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Last path segment, for either separator. */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** "18 KB", "1.2 MB" — data, shown in mono. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Elapsed seconds as m:ss (or h:mm:ss). */
export function formatStopwatch(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * For every included task, the dependencies it loses because the task it
 * depends on is left out (unchecked). Keys with nothing lost are absent.
 */
export function lostDependencies(tasks: BriefTaskDraft[], excluded: ReadonlySet<string>): Map<string, string[]> {
  const lost = new Map<string, string[]>();
  for (const task of tasks) {
    if (excluded.has(task.key)) continue;
    const gone = task.dependsOn.filter((dep) => excluded.has(dep));
    if (gone.length > 0) lost.set(task.key, gone);
  }
  return lost;
}

/** Included tasks that depend on `key` (shown on an unchecked row). */
export function dependentsOf(tasks: BriefTaskDraft[], key: string, excluded: ReadonlySet<string>): string[] {
  return tasks.filter((t) => !excluded.has(t.key) && t.dependsOn.includes(key)).map((t) => t.key);
}

/**
 * The tasks to create: included tasks in proposal order, with dependencies on
 * left-out or unknown tasks dropped, duplicates and self-references removed,
 * titles trimmed and empty acceptance criteria removed.
 */
export function buildCreatePayload(tasks: BriefTaskDraft[], excluded: ReadonlySet<string>): BriefTaskDraft[] {
  const included = tasks.filter((t) => !excluded.has(t.key));
  const keys = new Set(included.map((t) => t.key));
  return included.map((task) => ({
    ...task,
    title: task.title.trim(),
    acceptanceCriteria: task.acceptanceCriteria.map((ac) => ac.trim()).filter(Boolean),
    dependsOn: [...new Set(task.dependsOn)].filter((dep) => dep !== task.key && keys.has(dep)),
  }));
}

export interface Waves {
  /** Wave n holds tasks whose dependencies all sit in earlier waves. */
  waves: string[][];
  /** Tasks that cannot be ordered (a dependency cycle). */
  cyclic: string[];
}

/**
 * Order tasks into waves: tasks with no dependencies first, then the tasks
 * that only depend on those, and so on. Dependencies on keys outside `tasks`
 * are ignored (they will not be created). Within a wave, proposal order is kept.
 */
export function computeWaves(tasks: BriefTaskDraft[]): Waves {
  const keys = new Set(tasks.map((t) => t.key));
  const remaining = new Map(tasks.map((t) => [t.key, new Set(t.dependsOn.filter((d) => d !== t.key && keys.has(d)))]));
  const order = tasks.map((t) => t.key);
  const waves: string[][] = [];
  const placed = new Set<string>();

  while (remaining.size > 0) {
    const wave = order.filter((key) => remaining.has(key) && [...(remaining.get(key) ?? [])].every((d) => placed.has(d)));
    if (wave.length === 0) break;
    for (const key of wave) {
      remaining.delete(key);
      placed.add(key);
    }
    waves.push(wave);
  }

  return { waves, cyclic: order.filter((key) => remaining.has(key)) };
}

export interface EpicGroup {
  epic: BriefEpic | null;
  tasks: BriefTaskDraft[];
}

/** Tasks grouped by epic in the proposal's epic order; tasks without a known epic come last. */
export function groupByEpic(epics: BriefEpic[], tasks: BriefTaskDraft[]): EpicGroup[] {
  const known = new Set(epics.map((e) => e.key));
  const groups: EpicGroup[] = epics
    .map((epic) => ({ epic, tasks: tasks.filter((t) => t.epic === epic.key) }))
    .filter((g) => g.tasks.length > 0);
  const loose = tasks.filter((t) => !t.epic || !known.has(t.epic));
  if (loose.length > 0) groups.push({ epic: null, tasks: loose });
  return groups;
}
