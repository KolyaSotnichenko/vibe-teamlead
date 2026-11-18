/**
 * The project's Context → Architecture tab: the latest cloud architecture drawn
 * from code (redraw.ts), the latest one an architect designed (a task's
 * TerraVision diagram), and the decisions (ADRs) of merged tasks, newest first.
 * Small reads of the project's own folders; no Electron.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { CloudArchitectureFile, CloudArchitectureView, CloudDecision, CloudDesigned } from '../../../shared/types/cloud-architecture';
import { parseAdr } from '../../ipc-handlers/task/workspace-parsers';
import { cloudArchitectureDir } from './after-merge';
import { readCloudArchitecture } from './redraw';
import { type CloudToolsReadiness, installHints } from './terravision';

export interface ViewTask {
  id: string;
  title: string;
  specId: string;
  status: string;
}

export interface ViewInput {
  projectPath: string;
  tasks: ViewTask[];
  /** Where a task's spec folder may be (the project's, then its worktree's) */
  specDirs: (task: ViewTask) => string[];
  enabled: boolean;
  tools: CloudToolsReadiness;
  platform: 'darwin' | 'win32' | 'linux';
}

const MAX_SVG_BYTES = 8 * 1024 * 1024;
const MAX_DECISIONS = 30;
const DESIGNED = /^cloud-architecture.*\.svg$/i;

async function svgDataUrl(file: string): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > MAX_SVG_BYTES) return undefined;
    return `data:image/svg+xml;base64,${(await readFile(file)).toString('base64')}`;
  } catch {
    return undefined;
  }
}

async function files(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return [];
  }
}

async function mtime(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

/** A file name from meta.json, only as a plain name inside latest/ */
const plain = (name: string | undefined) => (name && basename(name) === name && !name.startsWith('.') ? name : undefined);

async function latestDesign(input: ViewInput): Promise<{ task: ViewTask; dir: string; svg: string; at: number } | undefined> {
  let best: { task: ViewTask; dir: string; svg: string; at: number } | undefined;
  for (const task of input.tasks) {
    for (const specDir of input.specDirs(task)) {
      const dir = join(specDir, 'architecture', 'diagrams');
      const svg = (await files(dir)).filter((name) => DESIGNED.test(name)).sort()[0];
      if (!svg) continue;
      const at = await mtime(join(dir, svg));
      if (!best || at > best.at) best = { task, dir, svg, at };
      break;
    }
  }
  return best;
}

export async function cloudArchitectureView(input: ViewInput): Promise<CloudArchitectureView> {
  const { tools } = input;
  const view: CloudArchitectureView = {
    enabled: input.enabled,
    tools: { ready: tools.ready, drawFromCode: tools.drawFromCode, missing: tools.missing, hints: installHints(input.platform) },
    decisions: [],
  };

  const store = cloudArchitectureDir(input.projectPath);
  const meta = readCloudArchitecture(store);
  if (meta) {
    const svgName = plain(meta.drawn?.files.svg);
    const svg = svgName ? await svgDataUrl(join(store, 'latest', svgName)) : undefined;
    view.fromCode = { ...meta, ...(svg ? { svg } : {}) };
  }

  const design = await latestDesign(input);
  if (design) {
    const svg = await svgDataUrl(join(design.dir, design.svg));
    const drawio = `${basename(design.svg, '.svg')}.drawio`;
    const designed: CloudDesigned = {
      taskId: design.task.id,
      taskTitle: design.task.title,
      ...(svg ? { svg } : {}),
      hasDrawio: (await files(design.dir)).includes(drawio),
      at: design.at,
    };
    view.designed = designed;
  }

  const decisions: CloudDecision[] = [];
  for (const task of input.tasks.filter((t) => t.status === 'done')) {
    for (const specDir of input.specDirs(task)) {
      const dir = join(specDir, 'architecture', 'adr');
      const names = (await files(dir)).filter((name) => /\.md$/i.test(name) && !/^(readme|template)/i.test(name));
      if (!names.length) continue;
      for (const fileName of names) {
        try {
          const text = await readFile(join(dir, fileName), 'utf-8');
          const adr = parseAdr(fileName, text);
          decisions.push({ taskId: task.id, taskTitle: task.title, fileName, title: adr.title, ...(adr.status ? { status: adr.status } : {}), at: await mtime(join(dir, fileName)), markdown: text });
        } catch {
          // an unreadable ADR is left out
        }
      }
      break;
    }
  }
  view.decisions = decisions.sort((a, b) => b.at - a.at || a.fileName.localeCompare(b.fileName)).slice(0, MAX_DECISIONS);
  return view;
}

/** The file to open for the tab's buttons; only the known ones. */
export async function cloudArchitectureFile(input: ViewInput, file: CloudArchitectureFile): Promise<string | undefined> {
  const store = cloudArchitectureDir(input.projectPath);
  if (file === 'folder') return readCloudArchitecture(store)?.drawn ? join(store, 'latest') : undefined;
  if (file === 'svg' || file === 'drawio' || file === 'html') {
    const name = plain(readCloudArchitecture(store)?.drawn?.files[file]);
    if (!name) return undefined;
    const target = join(store, 'latest', name);
    return (await files(join(store, 'latest'))).includes(name) ? target : undefined;
  }
  const design = await latestDesign(input);
  if (!design) return undefined;
  if (file === 'designed-svg') return join(design.dir, design.svg);
  const drawio = `${basename(design.svg, '.svg')}.drawio`;
  return (await files(design.dir)).includes(drawio) ? join(design.dir, drawio) : undefined;
}
