/**
 * Brief import: a brief (document or free-form text) → epics and tasks.
 *
 * The brief is stored in the project under <autoBuildPath>/briefs/<id>/ so the
 * analyst (and later the spec agents) can read it; the analyst is a read-only
 * Claude Code session over the project that returns the proposal as
 * structured output. Creating the tasks is a separate, user-confirmed step.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import type { BriefProposal, BriefTaskDraft } from '../../../shared/types/brief';
import { isMacOS } from '../../platform';
import { runProcess } from '../../platform/exec';
import { READ_TOOLS, runClaudeTask } from '../claude-code/task';
import { tryLoadPrompt } from '../prompts/prompt-loader';
import type { ThinkingLevel } from '../config/types';
import { getFeatureSettings } from '../../ipc-handlers/feature-settings-helper';
import { type BriefProposalOutput, BriefProposalSchema } from '../schema/brief-proposal';
import type { StreamEvent } from '../session/types';

/** Brief files larger than this are refused (they would not fit the analyst's context anyway). */
const MAX_BRIEF_BYTES = 20 * 1024 * 1024;
const MAX_TASKS = 30;

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text']);
/** Converted to text with macOS textutil */
const RICH_EXTENSIONS = new Set(['.docx', '.doc', '.rtf', '.odt', '.html', '.htm']);

export class BriefError extends Error {}

export interface StoredBrief {
  briefId: string;
  dir: string;
  /** The file the analyst reads (brief.md, or the original PDF) */
  readPath: string;
}

export function briefsRoot(projectPath: string, autoBuildPath?: string): string {
  return join(projectPath, autoBuildPath || '.auto-claude', 'briefs');
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'brief'
  );
}

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Save the brief into the project and return what the analyst should read. */
export async function storeBrief(
  projectPath: string,
  autoBuildPath: string | undefined,
  input: { text?: string; filePath?: string },
): Promise<StoredBrief> {
  const text = input.text?.trim();
  const filePath = input.filePath;
  if (!text && !filePath) throw new BriefError('Paste a brief or choose a file.');

  const name = filePath ? basename(filePath, extname(filePath)) : (text ?? '').split('\n')[0];
  const briefId = `${stamp()}-${slugify(name)}`;
  const dir = join(briefsRoot(projectPath, autoBuildPath), briefId);
  mkdirSync(dir, { recursive: true });

  if (!filePath) {
    const readPath = join(dir, 'brief.md');
    writeFileSync(readPath, `${text}\n`, 'utf-8');
    return { briefId, dir, readPath };
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new BriefError('The brief file was not found.');
  if (statSync(filePath).size > MAX_BRIEF_BYTES) throw new BriefError('The brief file is larger than 20 MB.');
  const ext = extname(filePath).toLowerCase();
  const original = join(dir, `source${ext}`);
  copyFileSync(filePath, original);

  if (TEXT_EXTENSIONS.has(ext)) {
    const readPath = join(dir, 'brief.md');
    writeFileSync(readPath, readFileSync(filePath, 'utf-8'), 'utf-8');
    return { briefId, dir, readPath };
  }
  if (ext === '.pdf') {
    // Claude Code reads PDFs directly.
    return { briefId, dir, readPath: original };
  }
  if (RICH_EXTENSIONS.has(ext) && isMacOS()) {
    const result = await runProcess('/usr/bin/textutil', ['-convert', 'txt', '-stdout', original], { timeoutMs: 60_000 });
    if (result.code === 0 && result.stdout.trim()) {
      const readPath = join(dir, 'brief.md');
      writeFileSync(readPath, result.stdout, 'utf-8');
      return { briefId, dir, readPath };
    }
  }
  throw new BriefError(`Can't read ${ext || 'this'} files. Save the brief as Markdown, text or PDF and try again.`);
}

/**
 * Make the proposal safe to use: unique keys, dependencies that exist and point
 * backwards (no cycles), epics that exist, and at most MAX_TASKS tasks.
 */
export function normalizeProposal(briefId: string, output: BriefProposalOutput): BriefProposal {
  const seen = new Set<string>();
  const tasks = output.tasks.slice(0, MAX_TASKS).map((task, index) => {
    let key = task.key.trim() || `T${index + 1}`;
    while (seen.has(key)) key = `${key}b`;
    seen.add(key);
    return { ...task, key };
  });

  const order = new Map(tasks.map((t, i) => [t.key, i]));
  const epicKeys = new Set(output.epics.map((e) => e.key));
  const fallbackEpic = output.epics[0]?.key;

  const normalized: BriefTaskDraft[] = tasks.map((task, index) => ({
    key: task.key,
    title: task.title.trim(),
    description: task.description.trim(),
    epic: epicKeys.has(task.epic) ? task.epic : fallbackEpic,
    acceptanceCriteria: task.acceptanceCriteria.map((c) => c.trim()).filter(Boolean),
    // Only earlier tasks: removes unknown keys, self-references and cycles.
    dependsOn: [...new Set(task.dependsOn)].filter((dep) => (order.get(dep) ?? Number.POSITIVE_INFINITY) < index),
    complexity: task.complexity,
    priority: task.priority,
    category: task.category,
    sourceSection: task.sourceSection.trim() || undefined,
  }));

  return {
    briefId,
    title: output.title.trim(),
    summary: output.summary.trim(),
    epics: output.epics.map((e) => ({ key: e.key, title: e.title, summary: e.summary || undefined })),
    tasks: normalized,
    assumptions: output.assumptions.filter((a) => a.trim()),
    openQuestions: output.openQuestions.filter((q) => q.trim()),
  };
}

/** One human-readable progress line for an analyst event, or null to skip it. */
export function progressLine(event: StreamEvent, projectPath: string): string | null {
  if (event.type !== 'tool-call') return null;
  const args = (event.args ?? {}) as Record<string, unknown>;
  const target = String(args.file_path ?? args.path ?? args.pattern ?? '');
  const shown = target.startsWith(projectPath) ? relative(projectPath, target) || '.' : target;
  switch (event.toolName) {
    case 'Read':
      return `Reading ${shown}`;
    case 'Glob':
    case 'Grep':
      return `Searching the project: ${shown}`;
    default:
      return null;
  }
}

export interface AnalyzeBriefOptions {
  projectPath: string;
  autoBuildPath?: string;
  input: { text?: string; filePath?: string };
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export async function analyzeBrief(options: AnalyzeBriefOptions): Promise<BriefProposal> {
  const { projectPath, signal, onProgress } = options;
  const brief = await storeBrief(projectPath, options.autoBuildPath, options.input);
  onProgress?.('Brief saved; the analyst is reading it');

  const systemPrompt = tryLoadPrompt('brief_analyst');
  if (!systemPrompt) throw new BriefError('The brief analyst prompt is missing from this build.');

  const feature = getFeatureSettings('briefImport');
  const result = await runClaudeTask({
    systemPrompt,
    prompt: [
      `The brief is at ${brief.readPath}. Read all of it.`,
      `The project root is ${projectPath}.`,
      'Propose the epics and tasks as described in your instructions.',
    ].join('\n'),
    // Settings → Agents → feature models ("Spec document import")
    model: feature.model,
    thinkingLevel: feature.thinkingLevel as ThinkingLevel,
    tools: READ_TOOLS,
    cwd: projectPath,
    agentType: 'brief_analyst',
    outputSchema: BriefProposalSchema,
    maxTurns: 60,
    abortSignal: signal,
    onEvent: (event) => {
      const line = progressLine(event, projectPath);
      if (line) onProgress?.(line);
    },
  });

  if (!result.output) throw new BriefError('The analyst did not return a proposal. Try again.');
  const proposal = normalizeProposal(brief.briefId, result.output);
  if (!proposal.tasks.length) throw new BriefError('The analyst found nothing to build in this brief.');
  writeFileSync(join(brief.dir, 'proposal.json'), JSON.stringify(proposal, null, 2), 'utf-8');
  return proposal;
}

/** Description written into a task created from a brief. */
export function taskDescription(task: BriefTaskDraft, briefRelPath: string): string {
  const parts = [task.description.trim()];
  if (task.acceptanceCriteria.length) {
    parts.push('', '## Acceptance criteria (draft)', '', ...task.acceptanceCriteria.map((c) => `- ${c}`));
  }
  parts.push('', `Source: ${briefRelPath}${task.sourceSection ? ` — ${task.sourceSection}` : ''}`);
  return parts.join('\n');
}
