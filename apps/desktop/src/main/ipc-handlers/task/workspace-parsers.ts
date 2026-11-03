/**
 * Task workspace parsers
 * ======================
 *
 * Pure functions that turn the agents' spec-directory artifacts into the
 * TaskWorkspace payload. No file system access here — see workspace-loader.ts.
 *
 * Every function is defensive: malformed input yields an empty result rather
 * than an exception, because these files are written by LLM agents.
 */

import path from 'path';
import type { TaskLogs, TaskLogEntry, TaskLogPhase, TaskLogPhaseStatus } from '../../../shared/types/task';
import type {
  AcStatus,
  AcTestLevel,
  AcTestResult,
  WorkspaceAcceptanceCriterion,
  WorkspaceAdr,
  WorkspacePlan,
  WorkspacePlanPhase,
  WorkspacePlanSubtask,
  WorkspaceSubtaskStatus,
  WorkspaceSecurity,
  WorkspaceTimelineItem,
} from '../../../shared/types/task-workspace';

// =============================================================================
// Acceptance criteria (spec.md)
// =============================================================================

const AC_ID_RE = /AC-(\d+)/gi;
const AC_MARKER_RE = /\*\*\s*(AC-\d+)\s*\*\*/i;
const TEST_SUFFIX_RE = /\s*(?:—|–|-{1,2})\s*Test\s*:\s*([^\n]*)$/i;

function normalizeAcId(raw: string): string {
  const match = /AC-(\d+)/i.exec(raw);
  return match ? `AC-${Number(match[1])}` : raw.trim().toUpperCase();
}

function parseTestLevel(raw: string): AcTestLevel | null {
  const value = raw.toLowerCase();
  if (/\be2e\b|end[-\s]?to[-\s]?end/.test(value)) return 'e2e';
  if (/\bintegration\b/.test(value)) return 'integration';
  if (/\bunit\b/.test(value)) return 'unit';
  if (/\bmanual\b|not automatable/.test(value)) return 'manual';
  return null;
}

export interface ParsedCriterion {
  id: string;
  text: string;
  testLevel: AcTestLevel | null;
}

/**
 * Extract acceptance criteria from spec.md.
 * A criterion is any line (outside code fences) with a bold `**AC-n**` marker.
 * The first occurrence of an ID wins; later mentions (e.g. in tables) are ignored.
 */
export function parseAcceptanceCriteria(markdown: string): ParsedCriterion[] {
  if (typeof markdown !== 'string' || !markdown) return [];
  const result: ParsedCriterion[] = [];
  const seen = new Set<string>();
  let inFence = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const marker = AC_MARKER_RE.exec(rawLine);
    if (!marker) continue;
    const id = normalizeAcId(marker[1]);
    if (seen.has(id)) continue;

    let text = rawLine.slice((marker.index ?? 0) + marker[0].length);
    let testLevel: AcTestLevel | null = null;
    const suffix = TEST_SUFFIX_RE.exec(text);
    if (suffix) {
      testLevel = parseTestLevel(suffix[1]);
      text = text.slice(0, suffix.index);
    }
    text = text.replace(/^\s*[:.—–-]?\s*/, '').trim();

    seen.add(id);
    result.push({ id, text, testLevel });
  }

  return result;
}

// =============================================================================
// QA coverage table (qa_report.md)
// =============================================================================

export interface QaCoverageRow {
  acIds: string[];
  test: AcTestResult;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function stripInlineMarkdown(cell: string): string {
  return cell.replace(/`/g, '').replace(/\*\*/g, '').trim();
}

function normalizeResult(cell: string): AcTestResult['result'] {
  const value = stripInlineMarkdown(cell).toLowerCase();
  if (/\bfail(ed|ing)?\b|❌|✗/.test(value)) return 'fail';
  if (/\bpass(ed|ing)?\b|✅|✓/.test(value)) return 'pass';
  return 'unknown';
}

/**
 * Parse every AC coverage table in qa_report.md: a markdown table whose header
 * has an "AC" column and a "Result" column. Returns null if no such table exists.
 * Later tables (e.g. a re-review section appended below) override nothing —
 * rows are returned in order and the merge step decides.
 */
export function parseQaCoverage(markdown: string): QaCoverageRow[] | null {
  if (typeof markdown !== 'string' || !markdown) return null;
  const lines = markdown.split(/\r?\n/);
  const rows: QaCoverageRow[] = [];
  let foundTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    const header = splitTableRow(line).map((h) => stripInlineMarkdown(h).toLowerCase());
    const acCol = header.findIndex((h) => h === 'ac' || h === 'criterion' || h === 'acceptance criterion');
    const resultCol = header.findIndex((h) => h.startsWith('result') || h === 'status');
    if (acCol === -1 || resultCol === -1) continue;
    const separator = lines[i + 1];
    if (!separator || !/^\s*\|?\s*:?-{2,}/.test(separator)) continue;

    foundTable = true;
    const testCol = header.findIndex((h) => h.startsWith('test'));
    const assertsCol = header.findIndex((h) => h.startsWith('asserts'));

    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const cells = splitTableRow(lines[j]);
      const acCell = cells[acCol] ?? '';
      const acIds = Array.from(new Set(Array.from(acCell.matchAll(AC_ID_RE), (m) => `AC-${Number(m[1])}`)));
      if (acIds.length === 0) continue;
      rows.push({
        acIds,
        test: {
          test: testCol === -1 ? '' : stripInlineMarkdown(cells[testCol] ?? ''),
          asserts: assertsCol === -1 ? '' : stripInlineMarkdown(cells[assertsCol] ?? ''),
          result: normalizeResult(cells[resultCol] ?? ''),
        },
      });
    }
    i = j - 1;
  }

  return foundTable ? rows : null;
}

/**
 * Status of one AC from its QA rows:
 * - fail when any row failed, or a test is recorded as not asserting the criterion;
 * - pass when at least one row passed and none failed;
 * - untested otherwise (no rows, or only rows without a result).
 */
export function deriveAcStatus(tests: AcTestResult[]): AcStatus {
  if (tests.length === 0) return 'untested';
  const doesNotAssert = (t: AcTestResult) => /^no\b/i.test(t.asserts);
  if (tests.some((t) => t.result === 'fail' || (t.result === 'pass' && doesNotAssert(t)))) return 'fail';
  if (tests.some((t) => t.result === 'pass')) return 'pass';
  return 'untested';
}

// =============================================================================
// Subtask AC prefix ("[AC-2, AC-3] ...")
// =============================================================================

/** AC IDs listed in a leading `[AC-..]` prefix of a subtask description. */
export function parseAcPrefix(description: unknown): string[] {
  if (typeof description !== 'string') return [];
  const match = /^\s*\[([^\]]*AC-\d+[^\]]*)\]/i.exec(description);
  if (!match) return [];
  return Array.from(new Set(Array.from(match[1].matchAll(AC_ID_RE), (m) => `AC-${Number(m[1])}`)));
}

// =============================================================================
// Implementation plan (implementation_plan.json)
// =============================================================================

const STATUS_ALIASES: Record<string, WorkspaceSubtaskStatus> = {
  done: 'completed',
  complete: 'completed',
  completed: 'completed',
  finished: 'completed',
  success: 'completed',
  pending: 'pending',
  not_started: 'pending',
  todo: 'pending',
  queued: 'pending',
  backlog: 'pending',
  in_progress: 'in_progress',
  running: 'in_progress',
  active: 'in_progress',
  wip: 'in_progress',
  working: 'in_progress',
  blocked: 'blocked',
  stuck: 'blocked',
  waiting: 'blocked',
  failed: 'failed',
  error: 'failed',
  errored: 'failed',
};

function normalizeSubtaskStatus(value: unknown): WorkspaceSubtaskStatus {
  if (typeof value !== 'string') return 'pending';
  return STATUS_ALIASES[value.toLowerCase().trim()] ?? 'pending';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((v): v is string => v !== undefined);
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * Parse implementation_plan.json (already JSON-decoded). Accepts the same field
 * aliases the planner schema coerces (subtask_id, chunks, title/name, ...).
 * Returns undefined when there are no phases with subtasks.
 */
export function parsePlan(raw: unknown): WorkspacePlan | undefined {
  const plan = asRecord(raw);
  if (!plan) return undefined;

  let rawPhases: unknown[] | undefined = Array.isArray(plan.phases) ? plan.phases : undefined;
  if (!rawPhases) {
    const flat = plan.steps ?? plan.tasks ?? plan.implementation_steps ?? plan.subtasks;
    if (Array.isArray(flat)) rawPhases = [{ id: '1', name: asString(plan.feature) ?? 'Implementation', subtasks: flat }];
  }
  if (!rawPhases) return undefined;

  // phase number → phase id, for numeric depends_on references
  const phaseNumberToId = new Map<string, string>();
  const phases: WorkspacePlanPhase[] = [];
  const usedSubtaskIds = new Set<string>();

  rawPhases.forEach((rawPhase, phaseIndex) => {
    const phase = asRecord(rawPhase);
    if (!phase) return;
    const phaseNumber = asString(phase.phase);
    const id = asString(phase.id) ?? asString(phase.phase_id) ?? (phaseNumber ? `phase-${phaseNumber}` : `phase-${phaseIndex + 1}`);
    if (phaseNumber) phaseNumberToId.set(phaseNumber, id);
    phaseNumberToId.set(String(phaseIndex + 1), phaseNumberToId.get(String(phaseIndex + 1)) ?? id);

    const rawSubtasks = phase.subtasks ?? phase.chunks ?? phase.tasks;
    const subtasks: WorkspacePlanSubtask[] = [];
    if (Array.isArray(rawSubtasks)) {
      rawSubtasks.forEach((rawSubtask, subtaskIndex) => {
        const subtask = typeof rawSubtask === 'string' ? { title: rawSubtask } : asRecord(rawSubtask);
        if (!subtask) return;
        let subtaskId =
          asString(subtask.id) ?? asString(subtask.subtask_id) ?? asString(subtask.task_id) ?? `${id}-${subtaskIndex + 1}`;
        while (usedSubtaskIds.has(subtaskId)) subtaskId = `${subtaskId}'`;
        usedSubtaskIds.add(subtaskId);

        const description = asString(subtask.description) ?? asString(subtask.details) ?? '';
        const title =
          asString(subtask.title) ?? asString(subtask.name) ?? asString(subtask.summary) ?? (description || subtaskId);
        const acIds = parseAcPrefix(description);
        const verification = asRecord(subtask.verification);
        const verificationType = verification ? asString(verification.type) ?? asString(verification.method) : undefined;

        subtasks.push({
          id: subtaskId,
          title: parseAcPrefix(title).length > 0 ? title.replace(/^\s*\[[^\]]*\]\s*/, '') : title,
          description,
          status: normalizeSubtaskStatus(subtask.status),
          phaseId: id,
          acIds: acIds.length > 0 ? acIds : parseAcPrefix(title),
          dependsOn: asIdList(subtask.depends_on ?? subtask.dependencies ?? subtask.blocked_by),
          files: Array.from(new Set([...asStringList(subtask.files_to_create), ...asStringList(subtask.files_to_modify)])),
          ...(verificationType
            ? { verification: { type: verificationType, run: asString(verification?.run) ?? asString(verification?.command) } }
            : {}),
        });
      });
    }

    phases.push({
      id,
      name: asString(phase.name) ?? asString(phase.title) ?? id,
      type: asString(phase.type),
      dependsOn: asIdList(phase.depends_on),
      subtasks,
    });
  });

  // Resolve numeric phase references and drop dangling ones
  const phaseIds = new Set(phases.map((p) => p.id));
  for (const phase of phases) {
    phase.dependsOn = phase.dependsOn
      .map((ref) => (phaseIds.has(ref) ? ref : phaseNumberToId.get(ref) ?? ref))
      .filter((ref) => phaseIds.has(ref) && ref !== phase.id);
  }
  for (const phase of phases) {
    for (const subtask of phase.subtasks) {
      subtask.dependsOn = subtask.dependsOn.filter((ref) => usedSubtaskIds.has(ref) && ref !== subtask.id);
    }
  }

  if (phases.every((p) => p.subtasks.length === 0)) return undefined;
  return { feature: asString(plan.feature) ?? asString(plan.title), phases };
}

// =============================================================================
// Merge: criteria + QA + plan
// =============================================================================

export function mergeCriteria(
  criteria: ParsedCriterion[],
  qaRows: QaCoverageRow[] | null,
  plan: WorkspacePlan | undefined
): WorkspaceAcceptanceCriterion[] {
  const testsByAc = new Map<string, AcTestResult[]>();
  for (const row of qaRows ?? []) {
    for (const acId of row.acIds) {
      const list = testsByAc.get(acId) ?? [];
      list.push(row.test);
      testsByAc.set(acId, list);
    }
  }

  const coveredBy = new Map<string, string[]>();
  for (const phase of plan?.phases ?? []) {
    for (const subtask of phase.subtasks) {
      for (const acId of subtask.acIds) {
        const list = coveredBy.get(acId) ?? [];
        list.push(subtask.id);
        coveredBy.set(acId, list);
      }
    }
  }

  return criteria.map((criterion) => {
    const tests = testsByAc.get(criterion.id) ?? [];
    return {
      ...criterion,
      tests,
      status: deriveAcStatus(tests),
      coveredBy: coveredBy.get(criterion.id) ?? [],
    };
  });
}

// =============================================================================
// Timeline (task_logs.json)
// =============================================================================

const LOG_PHASES: TaskLogPhase[] = ['planning', 'coding', 'validation'];

function validIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function byTime(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

function spanOf(entries: TaskLogEntry[]): { start: string; end: string } | null {
  const stamps = entries.map((e) => validIso(e.timestamp)).filter((s): s is string => s !== null).sort(byTime);
  if (stamps.length === 0) return null;
  return { start: stamps[0], end: stamps[stamps.length - 1] };
}

/**
 * Build a "what happened" timeline from recorded timestamps only.
 * - one item per phase that started (phase start/end from started_at/completed_at,
 *   falling back to the first/last entry timestamps);
 * - one item per agent session within a phase (entries carrying `session`);
 * - one item per subtask worked on during coding (entries carrying `subtask_id`).
 * An item whose phase is still active and which holds the latest entry has endedAt null.
 */
export function buildTimeline(raw: unknown): WorkspaceTimelineItem[] {
  const logs = asRecord(raw) as Partial<TaskLogs> | null;
  const phasesRecord = logs ? asRecord(logs.phases) : null;
  if (!phasesRecord) return [];
  const items: WorkspaceTimelineItem[] = [];

  for (const phaseName of LOG_PHASES) {
    const phase = asRecord(phasesRecord[phaseName]);
    if (!phase) continue;
    const entries = (Array.isArray(phase.entries) ? phase.entries : []).filter(
      (e): e is TaskLogEntry => !!asRecord(e) && validIso((e as TaskLogEntry).timestamp) !== null
    );
    const status: TaskLogPhaseStatus =
      phase.status === 'active' || phase.status === 'completed' || phase.status === 'failed' ? phase.status : 'pending';
    const span = spanOf(entries);
    const startedAt = validIso(phase.started_at) ?? span?.start ?? null;
    if (!startedAt) continue;
    const isActive = status === 'active';
    const endedAt = isActive ? null : validIso(phase.completed_at) ?? span?.end ?? null;

    items.push({
      id: `phase:${phaseName}`,
      kind: 'phase',
      phase: phaseName,
      startedAt,
      endedAt,
      status,
      entryCount: entries.length,
    });

    const groups: Array<{ kind: 'session' | 'subtask'; key: string; entries: TaskLogEntry[] }> = [];
    const sessions = new Map<number, TaskLogEntry[]>();
    const subtasks = new Map<string, TaskLogEntry[]>();
    for (const entry of entries) {
      if (typeof entry.session === 'number' && Number.isFinite(entry.session)) {
        const list = sessions.get(entry.session) ?? [];
        list.push(entry);
        sessions.set(entry.session, list);
      }
      if (typeof entry.subtask_id === 'string' && entry.subtask_id) {
        const list = subtasks.get(entry.subtask_id) ?? [];
        list.push(entry);
        subtasks.set(entry.subtask_id, list);
      }
    }
    for (const [session, list] of sessions) groups.push({ kind: 'session', key: String(session), entries: list });
    for (const [subtaskId, list] of subtasks) groups.push({ kind: 'subtask', key: subtaskId, entries: list });

    const latestInPhase = span?.end;
    for (const group of groups) {
      const groupSpan = spanOf(group.entries);
      if (!groupSpan) continue;
      const stillRunning = isActive && groupSpan.end === latestInPhase;
      items.push({
        id: `${group.kind}:${phaseName}:${group.key}`,
        kind: group.kind,
        phase: phaseName,
        startedAt: groupSpan.start,
        endedAt: stillRunning ? null : groupSpan.end,
        status: stillRunning ? 'active' : status === 'failed' && groupSpan.end === latestInPhase ? 'failed' : 'completed',
        ...(group.kind === 'session' ? { session: Number(group.key) } : { subtaskId: group.key }),
        entryCount: group.entries.length,
      });
    }
  }

  const kindOrder = { phase: 0, session: 1, subtask: 2 } as const;
  return items.sort((a, b) => byTime(a.startedAt, b.startedAt) || kindOrder[a.kind] - kindOrder[b.kind]);
}

// =============================================================================
// ADRs (architecture/adr/*.md, MADR)
// =============================================================================

export function parseAdr(fileName: string, markdown: string): WorkspaceAdr {
  const text = typeof markdown === 'string' ? markdown : '';
  let body = text;
  let status: string | undefined;

  // YAML front matter (MADR 3+): status: accepted
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (frontMatter) {
    const statusLine = /^status:\s*["']?([^"'\n]+)["']?\s*$/im.exec(frontMatter[1]);
    if (statusLine) status = statusLine[1].trim();
    body = text.slice(frontMatter[0].length);
  }
  if (!status) {
    // "* Status: accepted" / "Status: accepted" / "## Status\n\nAccepted"
    const inline = /^\s*[-*]?\s*\**status\**\s*:\s*\**([^\n*]+)/im.exec(body);
    const section = /^#{2,3}\s*status\s*\r?\n+\s*([^\n]+)/im.exec(body);
    status = (inline?.[1] ?? section?.[1])?.trim();
  }

  const heading = /^#\s+(.+)$/m.exec(body);
  const fallbackTitle = fileName.replace(/\.md$/i, '').replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ');
  return {
    fileName,
    title: heading ? heading[1].trim() : fallbackTitle,
    ...(status ? { status: status.toLowerCase() } : {}),
    markdown: text,
  };
}

// ---------------------------------------------------------------------------
// Security (security_gates.json, security_qa.json)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function parseSecurityGates(raw: unknown): WorkspaceSecurity['gates'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { ran?: unknown; skipped?: unknown; findings?: unknown };
  const findings = Array.isArray(r.findings) ? r.findings : [];
  return {
    ran: Array.isArray(r.ran) ? r.ran.filter((x): x is string => typeof x === 'string') : [],
    skipped: Array.isArray(r.skipped)
      ? r.skipped.flatMap((s) => (s && typeof s === 'object' && str((s as { gate?: unknown }).gate) ? [{ gate: String((s as { gate: string }).gate), reason: str((s as { reason?: unknown }).reason) ?? '' }] : []))
      : [],
    findings: findings.flatMap((f) => {
      if (!f || typeof f !== 'object') return [];
      const x = f as Record<string, unknown>;
      const source = x.gate === 'osv-scanner' ? 'osv-scanner' : 'gitleaks';
      const file = str(x.file);
      return [{ source, title: str(x.title) ?? 'Finding', location: file ? `${file}${typeof x.line === 'number' ? `:${x.line}` : ''}` : undefined, detail: str(x.detail), blocking: true }];
    }),
  };
}

export function parseSecurityQa(raw: unknown, specDir: string): WorkspaceSecurity['pentest'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const status = ['clear', 'findings', 'skipped', 'error', 'cancelled'].includes(String(r.status))
    ? (r.status as NonNullable<WorkspaceSecurity['pentest']>['status'])
    : 'error';
  const settings = (r.settings ?? {}) as Record<string, unknown>;
  const failOn = str(settings.failOn)?.toLowerCase();
  const threshold = failOn ? SEVERITY_ORDER.indexOf(failOn) : 1;
  const runDir = str(r.runDir);
  return {
    status,
    reason: str(r.reason),
    scanMode: str(settings.scanMode),
    failOn,
    costUsd: typeof r.costUsd === 'number' ? r.costUsd : undefined,
    reportPath: runDir ? path.relative(specDir, path.join(runDir, 'penetration_test_report.md')) : undefined,
    findings: (Array.isArray(r.findings) ? r.findings : []).flatMap((f) => {
      if (!f || typeof f !== 'object') return [];
      const x = f as Record<string, unknown>;
      const severity = str(x.severity)?.toLowerCase() ?? 'unknown';
      const rank = SEVERITY_ORDER.indexOf(severity);
      return [{ source: 'strix' as const, title: str(x.title) ?? 'Finding', severity, location: str(x.location), detail: str(x.description), blocking: rank === -1 || rank <= threshold }];
    }),
  };
}
