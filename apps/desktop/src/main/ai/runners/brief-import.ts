/**
 * Brief import: a brief (document or free-form text) → epics and tasks.
 *
 * The brief is stored in the project under <autoBuildPath>/briefs/<id>/ so the
 * analyst (and later the spec agents) can read it; the analyst is a read-only
 * Claude Code session over the project that returns the proposal as
 * structured output. Creating the tasks is a separate, user-confirmed step.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import type { BriefClarification, BriefOpenQuestion, BriefProposal, BriefTaskDraft } from '../../../shared/types/brief';
import type { AskUserHandler } from '../claude-code/user-questions';
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
  return join(projectPath, autoBuildPath || '.vibe-teamlead', 'briefs');
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
    openQuestions: normalizeOpenQuestions(output.openQuestions, normalized.map((t) => t.key)),
  };
}

const TASK_KEY = /\bT\d+\b/g;

/**
 * Each open question with the tasks whose spec depends on it. Only known task keys stay (`keys`;
 * any key when undefined). A question without one goes to the tasks its text names (`T5`), else
 * to the first task, so some spec agent always asks it. Older proposals hold plain strings.
 */
export function normalizeOpenQuestions(raw: unknown, keys?: string[]): BriefOpenQuestion[] {
  if (!Array.isArray(raw)) return [];
  const known = keys ? new Set(keys) : undefined;
  const isKnown = (key: string) => !known || known.has(key);
  const out: BriefOpenQuestion[] = [];
  for (const item of raw) {
    const entry = typeof item === 'string' ? { question: item, tasks: [] as unknown[] } : (item as { question?: unknown; tasks?: unknown });
    if (!entry || typeof entry.question !== 'string') continue;
    const question = entry.question.trim();
    if (!question) continue;
    const given = Array.isArray(entry.tasks) ? entry.tasks.filter((k): k is string => typeof k === 'string') : [];
    let tasks = [...new Set(given.filter(isKnown))];
    if (!tasks.length) tasks = [...new Set((question.match(TASK_KEY) ?? []).filter(isKnown))];
    if (!tasks.length && keys?.length) tasks = [keys[0]];
    out.push({ question, tasks });
  }
  return out;
}

/** The open questions saved with a brief's proposal (`proposal.json`); none when missing or unreadable. */
export function readProposalQuestions(briefDir: string): BriefOpenQuestion[] {
  try {
    const proposal = JSON.parse(readFileSync(join(briefDir, 'proposal.json'), 'utf-8')) as { openQuestions?: unknown };
    return normalizeOpenQuestions(proposal?.openQuestions);
  } catch {
    return [];
  }
}

/**
 * The questions each created task carries, by task key. `createdKeys` in creation order: a
 * question whose tasks were all left out goes to the first created task, so it is still asked.
 */
export function openQuestionsByTask(questions: BriefOpenQuestion[], createdKeys: string[]): Map<string, string[]> {
  const byTask = new Map<string, string[]>();
  if (!createdKeys.length) return byTask;
  const created = new Set(createdKeys);
  for (const q of questions) {
    const targets = q.tasks.filter((key) => created.has(key));
    for (const key of targets.length ? targets : [createdKeys[0]]) {
      const list = byTask.get(key) ?? [];
      if (!list.includes(q.question)) list.push(q.question);
      byTask.set(key, list);
    }
  }
  return byTask;
}

/**
 * Answers the user gave to an agent of a task made from this brief: added to the brief's
 * clarifications.md, which every task of the brief points to, so nobody asks them again.
 * Skipped questions are not recorded.
 */
export function appendBriefAnswers(briefDir: string, specId: string, items: BriefClarification[]): void {
  // The question is the agent's wording (it can echo project files): one line with no heading marks,
  // so it can't forge another entry; a heading line in the user's answer is escaped for the same reason
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '');
  const noHeadings = (text: string) => text.trim().replace(/^(\s*)#/gm, '$1\\#');
  const answered = items
    .map((item) => ({ question: oneLine(item.question), answer: item.answer?.trim() ? noHeadings(item.answer) : undefined }))
    .filter((item) => item.question && item.answer);
  if (!answered.length) return;
  const file = join(briefDir, 'clarifications.md');
  const header = existsSync(file) ? '' : '# Clarifications\n\nDecisions the user made about this brief, with the answers.\n\n';
  const body = answered.map((item) => `## ${item.question}\n\n${item.answer}\n\n_Answered in task ${specId}._\n\n`).join('');
  appendFileSync(file, header + body, 'utf-8');
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
  input: { text?: string; filePath?: string; clarify?: boolean };
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Asks the user (the brief dialog). With it and `input.clarify`, the analyst clarifies before proposing. */
  askUser?: AskUserHandler;
}

/** The questions and answers, as the analyst's notes and the spec agents' context. Pure. */
export function clarificationsMarkdown(items: BriefClarification[]): string {
  const lines = ['# Clarifications', '', 'Questions the analyst asked before proposing the tasks, with the answers.', ''];
  for (const item of items) {
    lines.push(`## ${item.question}`, '', item.answer ? item.answer : '_Skipped: the analyst chose and noted an assumption._', '');
  }
  return lines.join('\n');
}

export async function analyzeBrief(options: AnalyzeBriefOptions): Promise<BriefProposal> {
  const { projectPath, signal, onProgress } = options;
  const brief = await storeBrief(projectPath, options.autoBuildPath, options.input);
  onProgress?.('Brief saved; the analyst is reading it');

  const systemPrompt = tryLoadPrompt('brief_analyst');
  if (!systemPrompt) throw new BriefError('The brief analyst prompt is missing from this build.');

  const feature = getFeatureSettings('briefImport');
  const clarify = options.input.clarify !== false && !!options.askUser;
  // Every question and its answer, as they happen (the proposal's record, not the model's)
  const clarifications: BriefClarification[] = [];
  const askUser: AskUserHandler | undefined = clarify && options.askUser
    ? async (questions, askSignal) => {
        onProgress?.('Waiting for your answer');
        const answers = await options.askUser!(questions, askSignal);
        for (const q of questions) clarifications.push({ question: q.question, answer: answers?.[q.question]?.trim() || undefined });
        onProgress?.(answers ? 'Answer received; the analyst continues' : 'Skipped; the analyst continues on an assumption');
        return answers;
      }
    : undefined;

  const result = await runClaudeTask({
    systemPrompt,
    prompt: [
      `The brief is at ${brief.readPath}. Read all of it.`,
      `The project root is ${projectPath}.`,
      clarify
        ? 'Clarification: ON. Follow "CLARIFY BEFORE YOU PROPOSE" in your instructions, then propose.'
        : 'Clarification: OFF. Do not ask questions; propose on stated assumptions.',
      'Propose the epics and tasks as described in your instructions.',
    ].join('\n'),
    // Superpowers brainstorming drives the questions (only when clarifying)
    skills: clarify ? ['superpowers:brainstorming'] : [],
    askUser,
    // Settings → Agents → feature models (the spec document feature)
    model: feature.model,
    thinkingLevel: feature.thinkingLevel as ThinkingLevel,
    tools: clarify ? [...READ_TOOLS, 'AskUserQuestion', 'Skill'] : READ_TOOLS,
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
  const proposal = { ...normalizeProposal(brief.briefId, result.output), clarifications };
  if (!proposal.tasks.length) throw new BriefError('The analyst found nothing to build in this brief.');
  if (clarifications.length) writeFileSync(join(brief.dir, 'clarifications.md'), clarificationsMarkdown(clarifications), 'utf-8');
  writeFileSync(join(brief.dir, 'proposal.json'), JSON.stringify(proposal, null, 2), 'utf-8');
  return proposal;
}

/**
 * The user answered an agent of a task made from a brief: the answers go into that brief's
 * clarifications.md. Nothing for a dismissed question, a task not from a brief, or a brief id
 * that is not a plain folder name of an existing brief. Never throws.
 */
export function recordBriefAnswers(
  project: { path: string; autoBuildPath?: string },
  task: { specId: string; metadata?: { briefId?: unknown } },
  asked: { questions: { question: string }[] },
  answers: Record<string, string> | null,
): void {
  try {
    const briefId = task.metadata?.briefId;
    if (!answers || typeof briefId !== 'string' || !/^[\w.-]+$/.test(briefId) || briefId.startsWith('.')) return;
    const dir = join(briefsRoot(project.path, project.autoBuildPath), briefId);
    if (!existsSync(dir)) return;
    appendBriefAnswers(dir, task.specId, asked.questions.map((q) => ({ question: q.question, answer: answers[q.question] })));
  } catch {
    // The answer still reached the agent; only the shared record is missing
  }
}

/** Description written into a task created from a brief. */
export function taskDescription(
  task: BriefTaskDraft,
  briefRelPath: string,
  clarificationsRelPath?: string,
  openQuestions: string[] = [],
): string {
  const parts = [task.description.trim()];
  if (task.acceptanceCriteria.length) {
    parts.push('', '## Acceptance criteria (draft)', '', ...task.acceptanceCriteria.map((c) => `- ${c}`));
  }
  parts.push('', `Source: ${briefRelPath}${task.sourceSection ? ` — ${task.sourceSection}` : ''}`);
  if (clarificationsRelPath) parts.push(`Decisions from the brief Q&A: ${clarificationsRelPath}`);
  if (openQuestions.length) {
    const where = clarificationsRelPath ?? "the brief's clarifications.md";
    parts.push(
      '',
      '## Open questions from the brief',
      '',
      `The user has not answered these yet. Before you write the spec, look for each answer in ${where}. ` +
        'Ask the ones it does not answer with the AskUserQuestion tool; if no answer comes, go on with a clearly stated assumption.',
      '',
      ...openQuestions.map((q) => `- ${q}`),
    );
  }
  return parts.join('\n');
}
