/**
 * The Preview's UX review: one agent session that opens the running preview in a
 * headless browser, goes through the app from its home page as a person would, and
 * returns what stops people from using it. It reads the code only to name the file
 * to change. The last result is kept per project in the app's data.
 * No Electron imports: the caller passes the session runner and the data folder.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { UxReviewResult } from '../../shared/types/preview';
import { UX_REVIEW_SKILL } from '../ai/claude-code/skills';
import { previewSpecDir } from './preview-worktree';

const MAX_PAGES = 12;

const FindingSchema = z.object({
  page: z.string().min(1).max(300),
  width: z.number().int().min(200).max(4000),
  severity: z.enum(['blocks', 'note']),
  problem: z.string().min(1).max(1000),
  expected: z.string().min(1).max(1000),
  file: z.string().max(300).optional(),
});

export const UxReviewOutputSchema = z.object({
  summary: z.string().max(2000),
  pages: z.array(z.string().max(300)).max(50),
  findings: z.array(FindingSchema).max(60),
});

/** The request to the reviewer. Pure. */
export function uxReviewPrompt(url: string): string {
  return [
    `The project's app is running at ${url}, from its main branch. Review it as a person would use it, with the ux-review skill (load it with the Skill tool first).`,
    '',
    `- Start at \`/\` and follow the app's own navigation: links, menus, the redirects after signing in or submitting. Review at most ${MAX_PAGES} pages, the ones a person meets first and uses most.`,
    '- The whole app is in scope, not one task: for each page, the two widths, the keyboard, its states and how you got there, as the skill says.',
    "- If a page needs an account, register one through the app's own sign-up, or note that you could not get past sign-in.",
    "- The app is already running: don't start servers, don't install anything, don't change files. Read the code only to name the file to change.",
    '- Screenshots go under the spec directory\'s `qa-browser/` folder.',
    '',
    'Return every finding with the page, the width you saw it at, `blocks` or `note` (as the skill defines them), what is wrong, what it should do, and the file when you found it. Also the pages you opened, and a two-sentence summary.',
  ].join('\n');
}

const resultFile = (dataDir: string, projectId: string) => join(dataDir, 'preview', `${projectId.replace(/[^\w-]/g, '_')}-ux-review.json`);

/** The last review kept for the project, or null. */
export function readLastUxReview(dataDir: string, projectId: string): UxReviewResult | null {
  try {
    return JSON.parse(readFileSync(resultFile(dataDir, projectId), 'utf-8')) as UxReviewResult;
  } catch {
    return null;
  }
}

/** The part of runClaudeTask this needs; tests pass a fake. */
export type RunTask = (options: Record<string, unknown>) => Promise<{ text: string; output?: unknown }>;

export interface UxReviewOptions {
  projectId: string;
  url: string;
  /** The preview's worktree of main */
  worktree: string;
  /** The app's data folder (results are kept under preview/) */
  dataDir: string;
  runTask: RunTask;
  /** The model the owner chose for the UX review in Settings */
  model: { model: string; thinkingLevel: string };
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
}

export async function runUxReview(options: UxReviewOptions): Promise<UxReviewResult> {
  const result = await options.runTask({
    systemPrompt:
      "You are a UX reviewer. You look at a running web app the way a person uses it and report what stops them, in the project's own terms. You review; you never change code.",
    prompt: uxReviewPrompt(options.url),
    agentType: 'ux_reviewer',
    // A tool list replaces the defaults: Skill must be named for the ux-review skill to load
    tools: ['Read', 'Glob', 'Grep', 'Skill'],
    cwd: options.worktree,
    specDir: previewSpecDir(options.worktree),
    skills: [UX_REVIEW_SKILL],
    outputSchema: UxReviewOutputSchema,
    model: options.model.model,
    thinkingLevel: options.model.thinkingLevel,
    maxTurns: 120,
    abortSignal: options.signal,
    onEvent: options.onEvent,
  });
  const parsed = UxReviewOutputSchema.safeParse(result.output);
  if (!parsed.success) throw new Error('The UX review returned no review. Try again, or pick another model for it in Settings.');
  const review: UxReviewResult = { ...parsed.data, at: new Date().toISOString() };
  mkdirSync(join(options.dataDir, 'preview'), { recursive: true });
  writeFileSync(resultFile(options.dataDir, options.projectId), JSON.stringify(review, null, 2), 'utf-8');
  return review;
}
