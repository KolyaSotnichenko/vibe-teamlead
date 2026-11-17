/**
 * What the review message tells besides the title (design item 3): acceptance criteria covered
 * (spec.md + the QA report), the app's own checks, files changed (+/−) and a link to the diff on
 * GitHub when the task branch was pushed. Also the QA browser's latest screenshots and the size a
 * photo must have for Telegram. Pure or plain file reads: no Electron, no git here.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { VerificationSummary } from '../../shared/utils/verification-summary';
import { mergeCriteria, parseAcceptanceCriteria, parseQaCoverage } from '../ipc-handlers/task/workspace-parsers';
import { type Html, htmlText, link, quote } from './format';
import type { Translate } from './i18n';

export interface ReviewDetails {
  criteria?: { passed: number; total: number };
  checks?: Pick<VerificationSummary, 'status' | 'source'>;
  files?: { files: number; additions: number; deletions: number };
  diffUrl?: string;
  /** The QA verdict's reason (qa_report.md), for an expandable quote */
  summary?: string;
}

const SUMMARY_CHARS = 1500;

/** The reason QA gave for its verdict: the text after "**Reason**:" in the report (that paragraph). Pure. */
export function qaSummary(qaMarkdown: string): string | undefined {
  const match = qaMarkdown.match(/\*\*Reason\*\*:?\s*([\s\S]*?)(?:\n\s*\n|\n\s*\*\*|\n#|$)/);
  const reason = match?.[1]?.trim();
  if (!reason) return undefined;
  return reason.length > SUMMARY_CHARS ? `${reason.slice(0, SUMMARY_CHARS - 1)}…` : reason;
}

/** `git diff --numstat` output → files, lines added and removed (binary files count as files) */
export function parseNumstat(text: string): { files: number; additions: number; deletions: number } {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    const [adds, dels, file] = line.split('\t');
    if (!file) continue;
    files++;
    additions += Number.parseInt(adds, 10) || 0;
    deletions += Number.parseInt(dels, 10) || 0;
  }
  return { files, additions, deletions };
}

/** How many acceptance criteria the QA report shows passing, of all in spec.md */
export function criteriaCoverage(specMarkdown: string, qaMarkdown: string): { passed: number; total: number } | undefined {
  const criteria = mergeCriteria(parseAcceptanceCriteria(specMarkdown), parseQaCoverage(qaMarkdown), undefined);
  if (!criteria.length) return undefined;
  return { passed: criteria.filter((c) => c.status === 'pass').length, total: criteria.length };
}

export function diffUrl(repo: { owner: string; repo: string }, base: string, specId: string): string {
  const part = (value: string) => value.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/compare/${part(base)}...${part(`vibe-teamlead/${specId}`)}`;
}

/** The detail lines of the review message (HTML), in the app language; the QA summary last, as an expandable quote */
export function reviewLines(details: ReviewDetails, t: Translate): Html[] {
  const h = htmlText(t);
  const lines: Html[] = [];
  if (details.criteria) {
    const { passed, total } = details.criteria;
    lines.push(h(passed >= total ? 'review.criteria' : 'review.criteriaMissing', { passed, total }));
  }
  if (details.checks) {
    const line = h(`review.checks.${details.checks.status}`);
    lines.push(details.checks.source === 'task' ? h('review.checksFromTask', { line }) : line);
  }
  if (details.files) lines.push(h('review.files', { count: details.files.files, additions: details.files.additions, deletions: details.files.deletions }));
  if (details.diffUrl) lines.push(h('review.diff', { link: link(details.diffUrl, t('review.diffLink')) }));
  if (details.summary) lines.push(quote(details.summary, { expandable: true }));
  return lines;
}

const PICTURE = /\.(png|jpe?g)$/i;

/** The newest pictures under `<dir>/qa-browser` of each dir (QA's browser screenshots), oldest first */
export function latestScreenshots(specDirs: string[], limit: number): string[] {
  const found: Array<{ file: string; mtime: number }> = [];
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (entry.isFile() && PICTURE.test(entry.name)) {
        try {
          found.push({ file: full, mtime: statSync(full).mtimeMs });
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  for (const dir of new Set(specDirs)) walk(path.join(dir, 'qa-browser'), 0);
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .reverse()
    .map((f) => f.file);
}

const MAX_WIDTH = 1600;
const MAX_HEIGHT = 8000;
const MAX_RATIO = 20;

/** The size a picture is sent at: Telegram wants width + height ≤ 10000 and a ratio ≤ 20 */
export function fitPhoto(width: number, height: number): { width: number; height: number; crop?: true } {
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (h / w > MAX_RATIO) return { width: w, height: w * MAX_RATIO, crop: true };
  return { width: w, height: h };
}
