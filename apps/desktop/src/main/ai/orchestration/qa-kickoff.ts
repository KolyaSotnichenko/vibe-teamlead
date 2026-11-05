/**
 * The QA reviewer's starting context: the acceptance criteria and a subtask
 * table instead of the whole spec.md and implementation_plan.json. Every turn
 * re-sends the first message, so 70 KB of spec and plan cost on every one of a
 * long review's turns; the reviewer reads a spec section only when a criterion
 * needs its detail. Pure, no Electron imports — tested directly.
 */

import { safeParseJson } from '../../utils/json-repair';

export interface QAKickoffInput {
  /** spec.md, or null when it can't be read */
  spec: string | null;
  /** implementation_plan.json as text, or null when it can't be read */
  plan: string | null;
  /** Where the files are, for the pointer line */
  specDir?: string;
}

/** A criterion line: an optional list marker or heading, optional bold, then `AC-n`. */
const AC_LINE = /^\s*(?:[-*+]|\d+[.)]|#{1,6})?\s*(?:\*\*|`)?AC-(\d+)(?:\*\*|`)?[:\s]/;
const DESCRIPTION_MAX = 120;
const SPEC_HEAD_MAX = 4096;

interface PlanSubtask {
  id?: string;
  subtask_id?: string;
  title?: string;
  description?: string;
  status?: string;
}

/** The `AC-n` lines of the spec, one per id, with markdown emphasis removed. */
export function acceptanceCriteriaLines(spec: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of spec.split('\n')) {
    const match = AC_LINE.exec(raw);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    const text = raw
      .trim()
      .replace(/^(?:[-*+]|\d+[.)]|#{1,6})\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/^`(AC-\d+)`/, '$1')
      .replace(/\s+/g, ' ');
    lines.push(`- ${text}`);
  }
  return lines;
}

/** The body of the first "Acceptance Criteria" or "Success Criteria" section, up to the next heading of its level or higher. */
function criteriaSection(spec: string): string | null {
  const lines = spec.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s+.*(acceptance|success)\s+criteria/i.test(l));
  if (start === -1) return null;
  const level = /^(#+)/.exec(lines[start])?.[1].length ?? 1;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading && heading[1].length <= level) break;
    body.push(line);
  }
  return body.join('\n').trim() || null;
}

function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const clean = line.replace(/\|/g, '/').replace(/\s+/g, ' ');
  return clean.length > DESCRIPTION_MAX ? `${clean.slice(0, DESCRIPTION_MAX - 1)}…` : clean;
}

/** A compact table of the plan's subtasks: id, status, first line of the description. */
export function subtaskTable(plan: string): string[] {
  const parsed = safeParseJson<{ phases?: Array<{ subtasks?: PlanSubtask[] }> }>(plan);
  if (!parsed || typeof parsed !== 'object') return ['implementation_plan.json could not be parsed; use `mcp__vibe-teamlead__get_build_progress` for the subtasks.'];
  const subtasks = (parsed.phases ?? []).flatMap((phase) => phase.subtasks ?? []);
  if (!subtasks.length) return ['The plan lists no subtasks.'];
  const completed = subtasks.filter((s) => s.status === 'completed').length;
  return [
    `${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}, ${completed} completed.`,
    '',
    '| ID | Status | Description |',
    '|----|--------|-------------|',
    ...subtasks.map((s) => `| ${s.id ?? s.subtask_id ?? '?'} | ${s.status ?? 'unknown'} | ${firstLine(s.description) || firstLine(s.title)} |`),
  ];
}

/** What the reviewer gets instead of spec.md and implementation_plan.json. */
export function qaKickoffContext(input: QAKickoffInput): string {
  const where = input.specDir ? `${input.specDir}/` : 'the spec directory: ';
  const parts: string[] = [];

  if (input.spec) {
    const acs = acceptanceCriteriaLines(input.spec);
    if (acs.length) {
      parts.push('## Acceptance criteria (from spec.md)', '', ...acs);
    } else {
      const section = criteriaSection(input.spec);
      if (section) {
        parts.push('## Criteria (from spec.md; it has no AC-n lines)', '', section);
      } else {
        const head = input.spec.length > SPEC_HEAD_MAX ? `${input.spec.slice(0, SPEC_HEAD_MAX)}\n…` : input.spec;
        parts.push('## Start of spec.md (it has no acceptance criteria section; read the rest of the file for the requirements)', '', head);
      }
    }
  } else {
    parts.push('## Acceptance criteria', '', 'spec.md could not be read; read it from the spec directory.');
  }

  parts.push('', '## Subtasks (from implementation_plan.json)', '');
  parts.push(...(input.plan ? subtaskTable(input.plan) : ['implementation_plan.json could not be read; use `mcp__vibe-teamlead__get_build_progress`.']));

  parts.push(
    '',
    `The full spec is ${where}spec.md and the plan is ${where}implementation_plan.json. Read a specific spec.md section only when a criterion needs its detail; don't read either file whole.`,
  );
  return parts.join('\n');
}
