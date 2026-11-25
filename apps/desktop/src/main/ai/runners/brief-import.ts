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
import { getPlatformKey } from '../../platform';
import { runProcess } from '../../platform/exec';
import { readZipEntry, windowsTar } from '../../platform/zip';
import { READ_TOOLS, runClaudeTask } from '../claude-code/task';
import { tryLoadPrompt } from '../prompts/prompt-loader';
import type { ThinkingLevel } from '../config/types';
import { getFeatureSettings } from '../../ipc-handlers/feature-settings-helper';
import { type BriefProposalOutput, BriefProposalSchema } from '../schema/brief-proposal';
import type { StreamEvent } from '../session/types';

/** Brief files larger than this are refused (they would not fit the analyst's context anyway). */
const MAX_BRIEF_BYTES = 20 * 1024 * 1024;
/**
 * How many times the analyst is asked for the next part of a brief. A part is about 25 tasks, so
 * this is far more than any brief needs: it only ends a run that would never end.
 */
const MAX_PARTS = 40;

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text']);
/** Converted to text with macOS textutil; on Windows only .docx is read (docxText) */
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

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name[0] !== '#') return XML_ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const DOCX_RUN = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;

/**
 * The text of a .docx body (word/document.xml): one line per paragraph (table cells included),
 * with tabs and line breaks kept. Formatting, images and fields are dropped. Pure.
 */
export function docxText(xml: string): string {
  // An empty paragraph (<w:p/>) is still a line
  const paragraphs = xml.replace(/<w:p(?:\s[^>]*)?\/>/g, '</w:p>').split('</w:p>');
  paragraphs.pop(); // what follows the last paragraph holds no text
  const lines = paragraphs.map((para) => {
    let line = '';
    for (const m of para.matchAll(DOCX_RUN)) {
      if (m[1] !== undefined) line += decodeXml(m[1]);
      else line += m[0].startsWith('<w:tab') ? '\t' : '\n';
    }
    return line;
  });
  return lines.join('\n').trimEnd();
}

export interface StoreBriefOptions {
  platform?: 'darwin' | 'win32' | 'linux';
  /** bsdtar for reading a .docx off macOS; replaced in tests */
  tar?: string;
}

/** Save the brief into the project and return what the analyst should read. */
export async function storeBrief(
  projectPath: string,
  autoBuildPath: string | undefined,
  input: { text?: string; filePath?: string },
  opts: StoreBriefOptions = {},
): Promise<StoredBrief> {
  const platform = opts.platform ?? getPlatformKey();
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
  if (RICH_EXTENSIONS.has(ext) && platform === 'darwin') {
    const result = await runProcess('/usr/bin/textutil', ['-convert', 'txt', '-stdout', original], { timeoutMs: 60_000 });
    if (result.code === 0 && result.stdout.trim()) {
      const readPath = join(dir, 'brief.md');
      writeFileSync(readPath, result.stdout, 'utf-8');
      return { briefId, dir, readPath };
    }
  } else if (ext === '.docx') {
    // No textutil off macOS: a .docx is a zip, its text is in word/document.xml
    const xml = await readZipEntry(original, 'word/document.xml', { tar: opts.tar ?? (platform === 'win32' ? windowsTar() : 'tar') });
    const text = xml ? docxText(xml).trim() : '';
    if (text) {
      const readPath = join(dir, 'brief.md');
      writeFileSync(readPath, `${text}\n`, 'utf-8');
      return { briefId, dir, readPath };
    }
    throw new BriefError("Couldn't read the text of this .docx file. Save the brief as PDF, DOCX or Markdown and try again.");
  } else if (RICH_EXTENSIONS.has(ext)) {
    throw new BriefError(`Can't read ${ext} files on this system. Save the brief as PDF, DOCX or Markdown and try again.`);
  }
  throw new BriefError(`Can't read ${ext || 'this'} files. Save the brief as Markdown, text or PDF and try again.`);
}

/**
 * Make the proposal safe to use: unique keys, dependencies that exist and point
 * backwards (no cycles), epics that exist. Every task stays: a brief of any size becomes tasks.
 */
export function normalizeProposal(briefId: string, output: BriefProposalOutput): BriefProposal {
  const seen = new Set<string>();
  const tasks = output.tasks.map((task, index) => {
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
    covers: cleanList(task.covers),
  }));

  return {
    briefId,
    title: output.title.trim(),
    summary: output.summary.trim(),
    epics: output.epics.map((e) => ({ key: e.key, title: e.title, summary: e.summary || undefined })),
    tasks: normalized,
    assumptions: output.assumptions.filter((a) => a.trim()),
    openQuestions: normalizeOpenQuestions(output.openQuestions, normalized.map((t) => t.key)),
    notBuilt: notBuiltOf(output.notBuilt),
  };
}

/** Trimmed, non-empty strings, each once; anything else (a proposal from an older build has none) is no list. */
function cleanList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((item): item is string => typeof item === 'string').map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function notBuiltOf(raw: unknown): Array<{ what: string; why: string }> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Array<{ what: string; why: string }> = [];
  for (const item of raw as Array<{ what?: unknown; why?: unknown }>) {
    const [what] = cleanList([item?.what]);
    if (!what || seen.has(what)) continue;
    seen.add(what);
    out.push({ what, why: cleanList([item?.why])[0] ?? '' });
  }
  return out;
}

const REQUIREMENT_ID = /\b([A-Z][A-Z0-9]{0,7})-(\d{1,4})\b/g;

/**
 * The requirement ids a brief numbers its requirements with (FR-12, NFR-03), in the order they
 * first appear, each once. A prefix counts when the brief uses it with three numbers or more, so
 * UTF-8 or SHA-256 are not requirements. The app checks these itself: an analyst that says the
 * whole brief is covered is not taken at its word. Pure.
 */
export function briefRequirementIds(text: string): string[] {
  const byPrefix = new Map<string, Set<string>>();
  const ids: string[] = [];
  for (const match of text.matchAll(REQUIREMENT_ID)) {
    const id = match[0];
    const numbers = byPrefix.get(match[1]) ?? new Set<string>();
    numbers.add(match[2]);
    byPrefix.set(match[1], numbers);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.filter((id) => (byPrefix.get(id.slice(0, id.lastIndexOf('-')))?.size ?? 0) >= 3);
}

/** The ids named in a list of covered or excluded items ("FR-12", "FR-12: reports", "FR-12, FR-13"). Pure. */
function idsIn(items: string[]): Set<string> {
  return new Set(items.flatMap((item) => [...item.matchAll(REQUIREMENT_ID)].map((m) => m[0])));
}

/** What of the brief has no task: its ids nobody covers or excludes, then the analyst's own list. Pure. */
function uncoveredOf(briefIds: string[], output: BriefProposalOutput): string[] {
  const covered = idsIn(output.tasks.flatMap((t) => cleanList(t.covers)));
  const excluded = idsIn(notBuiltOf(output.notBuilt).map((n) => n.what));
  const ids = briefIds.filter((id) => !covered.has(id) && !excluded.has(id));
  // The analyst's lines about ids the app already lists are not said twice
  const listed = new Set(ids);
  const rest = cleanList(output.remaining).filter((line) => {
    const named = [...idsIn([line])];
    return !named.length || named.some((id) => !listed.has(id) && !covered.has(id) && !excluded.has(id)) || named.every((id) => !briefIds.includes(id));
  });
  return [...ids, ...rest.filter((line) => !listed.has(line))];
}

/** One proposal out of the parts the analyst returned: later tasks, epics, assumptions and questions added to the first. Pure. */
function mergeParts(parts: BriefProposalOutput[]): BriefProposalOutput {
  const [first, ...rest] = parts;
  const epicKeys = new Set(first.epics.map((e) => e.key));
  const merged: BriefProposalOutput = { ...first, epics: [...first.epics], tasks: [...first.tasks], assumptions: [...first.assumptions], openQuestions: [...first.openQuestions], notBuilt: [...(first.notBuilt ?? [])] };
  for (const part of rest) {
    for (const epic of part.epics ?? []) {
      if (epicKeys.has(epic.key)) continue;
      epicKeys.add(epic.key);
      merged.epics.push(epic);
    }
    merged.tasks.push(...(part.tasks ?? []));
    merged.assumptions.push(...(part.assumptions ?? []));
    merged.openQuestions.push(...(part.openQuestions ?? []));
    merged.notBuilt.push(...(part.notBuilt ?? []));
  }
  // What is left is what the last part says is left
  merged.remaining = parts[parts.length - 1].remaining ?? [];
  return merged;
}

/** The request for the next part: what exists, what is left. The titles are the analyst's own, sent back to it. Pure. */
function nextPartPrompt(readPath: string, projectPath: string, soFar: BriefProposalOutput, left: string[]): string {
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
  const tasks = soFar.tasks.map((t) => `- ${oneLine(t.key)} — ${oneLine(t.title)}${cleanList(t.covers).length ? ` [covers: ${cleanList(t.covers).join(', ')}]` : ''}`);
  const epics = soFar.epics.map((e) => `- ${oneLine(e.key)} — ${oneLine(e.title)}`);
  const last = soFar.tasks.length;
  return [
    `The brief is at ${readPath}. Read all of it.`,
    `The project root is ${projectPath}.`,
    'Clarification: OFF. Do not ask questions; propose on stated assumptions.',
    '',
    `This is the next part of a proposal you started: the brief is larger than one answer. ${last} task(s) exist so far. Propose the tasks for what is still not covered, as described in "THE WHOLE BRIEF" in your instructions.`,
    `Return only new tasks (keys go on from T${last + 1}; \`dependsOn\` may name earlier keys) and only new epics. Leave \`title\` and \`summary\` as they would be for the whole brief.`,
    '',
    'Epics so far:',
    ...epics,
    '',
    'Tasks so far:',
    ...tasks,
    '',
    "Parts of the brief no task covers yet (requirement ids the app found in the brief's text, and your own list from the last part):",
    ...left.map((line) => `- ${oneLine(line)}`),
    '',
    'Every one of them gets a task now or in a later part, or goes under `notBuilt` with the user\'s words that exclude it (or what it is, when it is not something to build). List in `remaining` what is still left after this part.',
  ].join('\n');
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

/** The brief's text when the app can read it as text (a PDF is read by the analyst only). Never throws. */
function briefText(readPath: string): string {
  if (!TEXT_EXTENSIONS.has(extname(readPath).toLowerCase())) return '';
  try {
    return readFileSync(readPath, 'utf-8');
  } catch {
    return '';
  }
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

  /** One part of the proposal: the first asks the user (when clarifying), the next ones go on from what exists */
  const part = (prompt: string, asking: boolean) =>
    runClaudeTask({
      systemPrompt,
      prompt,
      // Superpowers brainstorming drives the questions (only when clarifying)
      skills: asking ? ['superpowers:brainstorming'] : [],
      askUser: asking ? askUser : undefined,
      // Settings → Agents → feature models (the spec document feature)
      model: feature.model,
      thinkingLevel: feature.thinkingLevel as ThinkingLevel,
      tools: asking ? [...READ_TOOLS, 'AskUserQuestion', 'Skill'] : READ_TOOLS,
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

  const result = await part(
    [
      `The brief is at ${brief.readPath}. Read all of it.`,
      `The project root is ${projectPath}.`,
      clarify
        ? 'Clarification: ON. Follow "CLARIFY BEFORE YOU PROPOSE" in your instructions, then propose.'
        : 'Clarification: OFF. Do not ask questions; propose on stated assumptions.',
      'Propose the epics and tasks as described in your instructions.',
    ].join('\n'),
    clarify,
  );

  if (!result.output) throw new BriefError('The analyst did not return a proposal. Try again.');

  // The whole brief becomes tasks: the analyst is asked for the next part while something has none.
  // The brief's own requirement ids are checked here, not taken from what the analyst says is left
  const briefIds = briefRequirementIds(briefText(brief.readPath));
  const parts: BriefProposalOutput[] = [result.output];
  let merged = mergeParts(parts);
  let left = uncoveredOf(briefIds, merged);
  while (left.length && parts.length < MAX_PARTS && !signal?.aborted) {
    onProgress?.(`The brief is larger than one answer: ${merged.tasks.length} task(s) so far, ${left.length} part(s) of the brief still without a task; the analyst continues`);
    let next: BriefProposalOutput | undefined;
    try {
      next = (await part(nextPartPrompt(brief.readPath, projectPath, merged, left), false)).output ?? undefined;
    } catch {
      // What there is stays; the rest is shown as not covered
    }
    // A part that adds nothing would be asked for forever
    if (!next || (!(next.tasks ?? []).length && !(next.notBuilt ?? []).length)) break;
    parts.push(next);
    merged = mergeParts(parts);
    left = uncoveredOf(briefIds, merged);
  }

  const proposal = { ...normalizeProposal(brief.briefId, merged), clarifications, uncovered: left };
  if (!proposal.tasks.length) throw new BriefError('The analyst found nothing to build in this brief.');
  if (left.length) onProgress?.(`${left.length} part(s) of the brief have no task: they are listed with the proposal`);
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
  // The draft comes back from the review window: only a real list is used
  const covers = cleanList(task.covers);
  if (covers.length) {
    parts.push('', `Requirements of the brief this task builds, each in full as the brief states it (not a first or simplified version): ${covers.join(', ')}`);
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
        'Ask the ones it does not answer with the AskUserQuestion tool, whatever the plan approval setting: they are the user\'s decisions, not yours. Only if the tool says no answer is available, go on with a clearly stated assumption.',
      '',
      ...openQuestions.map((q) => `- ${q}`),
    );
  }
  return parts.join('\n');
}
