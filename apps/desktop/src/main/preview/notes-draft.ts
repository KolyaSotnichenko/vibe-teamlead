/**
 * The Preview's notes not sent yet, per project, in the project's `.vibe-teamlead/preview/`
 * folder (the app's own, never the project's code). They survive leaving the view and
 * restarting the app until they are sent or discarded. What is read back is checked again:
 * the folder is inside a project agents work in.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { cleanPick } from '../../preview-overlay/protocol';
import type { PreviewNote } from '../../shared/types/preview';
import { writeFileReplacingSync } from '../ai/safe-write';

const NOTES_MAX = 100;
const TEXT_MAX = 4000;
/** About 1.5 MB of PNG */
const IMAGE_MAX = 2 * 1024 * 1024;
const PNG = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/** The project's draft, or a task's (notes on its own preview) */
const draftFile = (projectPath: string, taskId?: string) =>
  join(projectPath, '.vibe-teamlead', 'preview', taskId ? `notes-task-${taskId.replace(/[^\w-]/g, '_').slice(0, 80)}.json` : 'notes.json');

function cleanNote(value: unknown): PreviewNote | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const pick = cleanPick(v.pick);
  if (!pick || typeof v.id !== 'string' || typeof v.n !== 'number' || typeof v.route !== 'string') return null;
  const note: PreviewNote = {
    id: v.id.slice(0, 64),
    n: v.n,
    route: v.route.slice(0, 500),
    width: typeof v.width === 'number' ? v.width : 0,
    text: typeof v.text === 'string' ? v.text.slice(0, TEXT_MAX) : '',
    pick,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt.slice(0, 40) : new Date().toISOString(),
  };
  if (typeof v.image === 'string' && v.image.length <= IMAGE_MAX && PNG.test(v.image)) note.image = v.image;
  return note;
}

const cleanNotes = (values: unknown): PreviewNote[] =>
  (Array.isArray(values) ? values : []).map(cleanNote).filter((n): n is PreviewNote => !!n).slice(0, NOTES_MAX);

export function readNotesDraft(projectPath: string, taskId?: string): PreviewNote[] {
  try {
    return cleanNotes((JSON.parse(readFileSync(draftFile(projectPath, taskId), 'utf-8')) as { notes?: unknown }).notes);
  } catch {
    return [];
  }
}

export function writeNotesDraft(projectPath: string, notes: unknown, taskId?: string): PreviewNote[] {
  const kept = cleanNotes(notes);
  mkdirSync(join(projectPath, '.vibe-teamlead', 'preview'), { recursive: true });
  writeFileReplacingSync(draftFile(projectPath, taskId), JSON.stringify({ notes: kept }), 'utf-8');
  return kept;
}

/** A task's draft goes with the task's worktree */
export function removeNotesDraft(projectPath: string, taskId: string): void {
  rmSync(draftFile(projectPath, taskId), { force: true });
}
