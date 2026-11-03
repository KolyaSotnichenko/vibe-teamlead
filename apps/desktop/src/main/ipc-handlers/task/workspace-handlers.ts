/**
 * Task workspace IPC handlers
 *
 * TASK_WORKSPACE_GET        → parsed view of a task's spec directory (spec, ACs,
 *                             plan, timeline from real log timestamps, architecture,
 *                             security). Diagram previews are referenced by path and
 *                             version only, so refreshes stay small.
 * TASK_WORKSPACE_GET_IMAGE  → one rendered diagram PNG as a data URL.
 * TASK_WORKSPACE_OPEN_FILE  → open a .drawio file of the spec directory in the
 *                             system's draw.io app.
 */

import { ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { IPC_CHANNELS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { TaskWorkspace, WorkspaceAdr, WorkspaceArchitecture, WorkspaceDiagram } from '../../../shared/types/task-workspace';
import { ensureAbsolutePath } from '../../utils/path-helpers';
import { findTaskWorktree } from '../../worktree-paths';
import { findTaskAndProject } from './shared';
import {
  buildTimeline,
  mergeCriteria,
  parseAcceptanceCriteria,
  parseAdr,
  parsePlan,
  parseQaCoverage,
  parseSecurityGates,
  parseSecurityQa,
} from './workspace-parsers';

/** Markdown/JSON larger than this is skipped rather than shipped over IPC */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** PNG previews larger than this are skipped */
const MAX_PNG_BYTES = 8 * 1024 * 1024;
/** Files the "Open in draw.io" action may open */
const OPENABLE = /\.drawio$/i;

async function readText(filePath: string): Promise<string | undefined> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile() || stats.size > MAX_TEXT_BYTES) return undefined;
    return await readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  const text = await readText(filePath);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Preview of a .drawio: the PNG the renderer saved next to it, as path + version (mtime). */
async function pngPreview(diagramDir: string, name: string): Promise<{ pngPath: string; pngVersion: number } | undefined> {
  for (const fileName of [`${name}.png`, `${name}.drawio.png`]) {
    try {
      const stats = await stat(path.join(diagramDir, fileName));
      if (stats.isFile() && stats.size <= MAX_PNG_BYTES) {
        return { pngPath: path.posix.join('architecture', 'diagrams', fileName), pngVersion: stats.mtimeMs };
      }
    } catch {
      // try the next name
    }
  }
  return undefined;
}

export async function loadArchitecture(specDir: string): Promise<WorkspaceArchitecture> {
  const archDir = path.join(specDir, 'architecture');
  const adrDir = path.join(archDir, 'adr');
  const diagramDir = path.join(archDir, 'diagrams');
  const [markdown, adrFiles, diagramFiles] = await Promise.all([
    readText(path.join(archDir, 'architecture.md')),
    listFiles(adrDir),
    listFiles(diagramDir),
  ]);

  const adrs: WorkspaceAdr[] = [];
  for (const fileName of adrFiles) {
    if (!/\.md$/i.test(fileName) || /^(readme|template)/i.test(fileName)) continue;
    const text = await readText(path.join(adrDir, fileName));
    if (text !== undefined) adrs.push(parseAdr(fileName, text));
  }

  const diagrams: WorkspaceDiagram[] = [];
  for (const fileName of diagramFiles) {
    const ext = path.extname(fileName).toLowerCase();
    const name = path.basename(fileName, path.extname(fileName));
    if (ext === '.drawio') {
      diagrams.push({
        name,
        kind: 'drawio',
        drawioPath: path.posix.join('architecture', 'diagrams', fileName),
        ...(await pngPreview(diagramDir, name)),
      });
    } else if (ext === '.mmd' || ext === '.mermaid') {
      const source = await readText(path.join(diagramDir, fileName));
      if (source?.trim()) diagrams.push({ name, kind: 'mermaid', mermaidSource: source });
    }
  }

  return { ...(markdown !== undefined ? { markdown } : {}), adrs, diagrams };
}

/** Read and parse every workspace artifact in a spec directory. Never throws. */
export async function loadTaskWorkspace(specDir: string): Promise<TaskWorkspace> {
  const file = (name: string) => path.join(specDir, name);
  const [specMarkdown, planRaw, qaMarkdown, logs, architecture, gates, pentest] = await Promise.all([
    readText(file('spec.md')),
    readJson(file('implementation_plan.json')),
    readText(file('qa_report.md')),
    readJson(file('task_logs.json')),
    loadArchitecture(specDir),
    readJson(file('security_gates.json')),
    readJson(file('security_qa.json')),
  ]);
  const plan = parsePlan(planRaw);
  const qaRows = qaMarkdown !== undefined ? parseQaCoverage(qaMarkdown) : null;

  return {
    specDir,
    ...(specMarkdown !== undefined
      ? { spec: { markdown: specMarkdown, criteria: mergeCriteria(parseAcceptanceCriteria(specMarkdown), qaRows, plan) } }
      : {}),
    hasQaCoverage: qaRows !== null,
    ...(plan ? { plan } : {}),
    timeline: buildTimeline(logs),
    architecture,
    security: {
      gates: parseSecurityGates(gates),
      pentest: parseSecurityQa(pentest, specDir),
    },
  };
}

/**
 * Where the task's spec files are now: while the task builds in its worktree,
 * the agents (QA reports, security results, architecture) write the worktree's
 * copy of the spec directory; the project's copy catches up on merge.
 */
export function resolveSpecDir(taskId: string, projectId?: string): string | null {
  const { task, project } = findTaskAndProject(taskId, projectId);
  if (!task || !project) return null;
  const projectPath = ensureAbsolutePath(project.path);
  const specsBase = getSpecsDir(project.autoBuildPath);
  const worktree = findTaskWorktree(projectPath, task.specId);
  if (worktree) {
    const worktreeSpecDir = path.join(worktree, specsBase, task.specId);
    if (existsSync(worktreeSpecDir)) return worktreeSpecDir;
  }
  if (task.specsPath) return task.specsPath;
  return path.join(projectPath, specsBase, task.specId);
}

/** True when `target` is `root` or lies inside it (after resolving `..`). */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve a renderer-supplied path inside the task's spec directory, following
 * symlinks, so a link the agents created can't point outside it.
 */
export async function resolveSpecFile(specDir: string, relativePath: unknown): Promise<string | null> {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) return null;
  try {
    const [root, target] = await Promise.all([realpath(specDir), realpath(path.resolve(specDir, relativePath))]);
    return isInside(root, target) && (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

export function registerTaskWorkspaceHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKSPACE_GET,
    async (_, taskId: string, projectId?: string): Promise<IPCResult<TaskWorkspace | null>> => {
      try {
        const specDir = resolveSpecDir(taskId, projectId);
        if (!specDir) return { success: false, error: 'Task not found' };
        try {
          await stat(specDir);
        } catch {
          return { success: true, data: null };
        }
        return { success: true, data: await loadTaskWorkspace(specDir) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to load task workspace' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKSPACE_GET_IMAGE,
    async (_, taskId: string, relativePath: string, projectId?: string): Promise<IPCResult<string>> => {
      const specDir = resolveSpecDir(taskId, projectId);
      const target = specDir && /\.png$/i.test(String(relativePath)) ? await resolveSpecFile(specDir, relativePath) : null;
      if (!target) return { success: false, error: 'Image not found' };
      try {
        if ((await stat(target)).size > MAX_PNG_BYTES) return { success: false, error: 'Image too large' };
        return { success: true, data: `data:image/png;base64,${(await readFile(target)).toString('base64')}` };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to read image' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKSPACE_OPEN_FILE,
    async (_, taskId: string, relativePath: string, projectId?: string): Promise<IPCResult> => {
      const specDir = resolveSpecDir(taskId, projectId);
      const target = specDir && OPENABLE.test(String(relativePath)) ? await resolveSpecFile(specDir, relativePath) : null;
      if (!target || !OPENABLE.test(target)) return { success: false, error: 'File not found' };
      const error = await shell.openPath(target);
      return error ? { success: false, error } : { success: true };
    }
  );
}
