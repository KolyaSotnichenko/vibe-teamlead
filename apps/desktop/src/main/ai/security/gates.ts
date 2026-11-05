/**
 * Security gates run before every QA review.
 *
 * - gitleaks: secrets in what the build changed — commits since the base
 *   (catches a secret added and then deleted) and the current content of
 *   every changed or untracked file, scanned in one run.
 * - OSV-Scanner: known vulnerabilities newly introduced in changed lockfiles
 *   (compared with the same lockfile at the base, so pre-existing issues don't
 *   block the task).
 * - Semgrep (only when installed on the machine; it is a Python package, not
 *   bundled): its registry rules, ERROR severity, on the changed files.
 *
 * Findings are hard gates: QA cannot approve while any remain. Results are
 * written to <spec>/security_gates.json and security_gates.md for the QA agents
 * and the task workspace. A missing scanner skips its gate, and a scanner that
 * fails is reported as failed; neither blocks the build, both are visible.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { type RunResult, runProcess, searchPath } from '../../platform/exec';
import { withoutGitLocation } from '../../platform/git-env';
import { writeFileReplacing } from '../safe-write';

export type GateName = 'gitleaks' | 'osv-scanner' | 'semgrep';

export interface GateFinding {
  gate: GateName;
  /** Stable key used to compare iterations */
  key: string;
  title: string;
  file?: string;
  line?: number;
  detail?: string;
}

export interface GateReport {
  ran: GateName[];
  /** Gates that did not run (not installed, nothing to scan) or failed */
  skipped: { gate: GateName; reason: string }[];
  findings: GateFinding[];
  baseRef?: string;
}

export interface GateOptions {
  projectDir: string;
  specDir: string;
  gitleaksBin?: string;
  osvScannerBin?: string;
  /** Semgrep, when found on PATH (never bundled) */
  semgrepBin?: string;
  /** Semgrep fetches rules and scans whole files: its own, longer limit */
  semgrepTimeoutMs?: number;
  /** Base to diff against; resolved from the default branch when omitted */
  baseRef?: string;
  signal?: AbortSignal;
}

const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
const SEMGREP_TIMEOUT_MS = 10 * 60 * 1000;

class GateFailure extends Error {}

function git(args: string[], cwd: string): Promise<RunResult> {
  return runProcess('git', args, { cwd, timeoutMs: 30_000 });
}

/** Throw a GateFailure unless the scanner ran to completion with an expected exit code. */
function assertRan(result: RunResult, name: string, okCodes: number[]): void {
  if (result.aborted) throw new GateFailure(`${name} was cancelled`);
  if (result.timedOut) throw new GateFailure(`${name} timed out`);
  if (result.error) throw new GateFailure(`${name} could not start: ${result.error}`);
  if (!okCodes.includes(result.code)) {
    const detail = result.stderr.trim().split('\n').pop() ?? '';
    throw new GateFailure(`${name} exited with code ${result.code}${detail ? `: ${detail}` : ''}`);
  }
}

/** Lockfiles OSV-Scanner understands, by file name. */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'requirements.txt',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'Cargo.lock',
  'go.mod',
  'Gemfile.lock',
  'composer.lock',
  'pubspec.lock',
  'mix.lock',
  'gradle.lockfile',
  'packages.lock.json',
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

/** Merge-base of HEAD with the repository's default branch, if any. */
/** HEAD of the checkout, or undefined outside git. */
export async function currentCommit(cwd: string): Promise<string | undefined> {
  const head = await git(['rev-parse', 'HEAD'], cwd);
  return head.code === 0 ? head.stdout.trim() || undefined : undefined;
}

export async function resolveBaseRef(cwd: string): Promise<string | undefined> {
  const candidates: string[] = [];
  const originHead = await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd);
  if (originHead.code === 0 && originHead.stdout.trim()) candidates.push(originHead.stdout.trim());
  candidates.push('main', 'master', 'origin/main', 'origin/master');
  for (const ref of candidates) {
    const base = await git(['merge-base', 'HEAD', ref], cwd);
    if (base.code === 0 && base.stdout.trim()) return base.stdout.trim();
  }
  return undefined;
}

/**
 * The app's own folder in the project (specs, task logs, worktrees). It is not
 * the build's code: task logs quote test tokens from the agents' runs, so
 * scanning it blocked QA on findings no fixer can resolve.
 */
export const isAppDataPath = (file: string): boolean => /(^|\/)\.vibe-teamlead\//.test(file.replace(/\\/g, '/'));

/** Files changed relative to the base: committed, uncommitted and untracked (not the app's own folder). */
export async function changedFiles(cwd: string, baseRef?: string): Promise<string[]> {
  const files = new Set<string>();
  const collect = (result: RunResult) => {
    if (result.code !== 0) return;
    for (const f of result.stdout.split('\n')) if (f.trim()) files.add(f.trim());
  };
  collect(await git(['diff', '--name-only', '--diff-filter=ACMR', baseRef ?? 'HEAD'], cwd));
  collect(await git(['ls-files', '--others', '--exclude-standard'], cwd));
  return [...files].filter((f) => !isAppDataPath(f));
}

function dedupe(findings: GateFinding[]): GateFinding[] {
  const seen = new Map<string, GateFinding>();
  for (const f of findings) if (!seen.has(f.key)) seen.set(f.key, f);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// gitleaks
// ---------------------------------------------------------------------------

interface GitleaksLeak {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  Commit?: string;
}

/** Parse a gitleaks JSON report; `root` is stripped from file paths. */
export function parseGitleaks(json: string, root?: string): GateFinding[] {
  let leaks: GitleaksLeak[];
  try {
    const parsed = JSON.parse(json || '[]');
    leaks = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
  return leaks.map((leak) => {
    const file = root && leak.File?.startsWith(`${root}/`) ? leak.File.slice(root.length + 1) : leak.File;
    return {
      gate: 'gitleaks' as const,
      key: `gitleaks:${leak.RuleID ?? 'secret'}:${file ?? ''}:${leak.StartLine ?? 0}`,
      title: `Secret detected: ${leak.Description || leak.RuleID || 'credential'}`,
      file,
      line: leak.StartLine,
      detail: leak.Commit ? `in commit ${leak.Commit.slice(0, 10)}` : 'in the working tree',
    };
  });
}

async function readReport(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, 'utf-8') : '[]';
}

async function runGitleaks(
  bin: string,
  cwd: string,
  baseRef: string | undefined,
  files: string[],
  signal?: AbortSignal,
): Promise<GateFinding[]> {
  const work = mkdtempSync(join(tmpdir(), 'vtl-gitleaks-'));
  const common = ['--no-banner', '--redact', '--exit-code', '0', '--report-format', 'json'];
  const options = { cwd, signal, timeoutMs: SCAN_TIMEOUT_MS };
  try {
    const findings: GateFinding[] = [];

    if (baseRef) {
      const report = join(work, 'history.json');
      const args = ['git', ...common, '--report-path', report, '--log-opts', `${baseRef}..HEAD`, '.'];
      assertRan(await runProcess(bin, args, options), 'gitleaks', [0]);
      findings.push(...parseGitleaks(await readReport(report)));
    }

    // Copy the changed files into one tree and scan it in a single run.
    const tree = join(work, 'tree');
    let copied = 0;
    for (const file of files) {
      const source = join(cwd, file);
      if (!existsSync(source)) continue;
      mkdirSync(dirname(join(tree, file)), { recursive: true });
      copyFileSync(source, join(tree, file));
      copied++;
    }
    if (copied > 0) {
      const report = join(work, 'tree.json');
      assertRan(await runProcess(bin, ['dir', ...common, '--report-path', report, tree], options), 'gitleaks', [0]);
      findings.push(...parseGitleaks(await readReport(report), tree));
    }
    // Also for commits that added the app's folder
    return dedupe(findings.filter((f) => !f.file || !isAppDataPath(f.file)));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// OSV-Scanner
// ---------------------------------------------------------------------------

interface OsvOutput {
  results?: {
    source?: { path?: string };
    packages?: {
      package?: { name?: string; version?: string; ecosystem?: string };
      vulnerabilities?: { id?: string; summary?: string; aliases?: string[] }[];
      groups?: { ids?: string[]; max_severity?: string }[];
    }[];
  }[];
}

/** Parse OSV-Scanner JSON: one finding per advisory group (aliases of one advisory). */
export function parseOsv(json: string, file?: string): GateFinding[] {
  let out: OsvOutput;
  try {
    out = JSON.parse(json || '{}');
  } catch {
    return [];
  }
  const findings: GateFinding[] = [];
  for (const result of out.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const name = pkg.package?.name ?? 'unknown';
      const version = pkg.package?.version ?? '';
      const groups = pkg.groups?.length
        ? pkg.groups
        : (pkg.vulnerabilities ?? []).map((v) => ({ ids: [v.id ?? ''], max_severity: undefined }));
      for (const group of groups) {
        const ids = (group.ids ?? []).filter(Boolean);
        if (!ids.length) continue;
        const primary = ids[0];
        const vuln = pkg.vulnerabilities?.find((v) => v.id === primary);
        const severity = group.max_severity ? ` (CVSS ${group.max_severity})` : '';
        findings.push({
          gate: 'osv-scanner',
          key: `osv:${name}@${version}:${primary}`,
          title: `Vulnerable dependency: ${name}@${version} — ${primary}${severity}`,
          file: file ?? result.source?.path,
          detail: vuln?.summary,
        });
      }
    }
  }
  return dedupe(findings);
}

/** OSV-Scanner exits 0 (clean), 1 (vulnerabilities found) or 128 (no packages). */
async function scanLockfile(bin: string, path: string, cwd: string, signal?: AbortSignal): Promise<GateFinding[]> {
  const result = await runProcess(bin, ['scan', 'source', '--format', 'json', '--lockfile', path], {
    cwd,
    signal,
    timeoutMs: SCAN_TIMEOUT_MS,
  });
  assertRan(result, 'OSV-Scanner', [0, 1, 128]);
  return parseOsv(result.stdout);
}

async function runOsv(
  bin: string,
  cwd: string,
  baseRef: string | undefined,
  files: string[],
  signal?: AbortSignal,
): Promise<GateFinding[]> {
  const findings: GateFinding[] = [];
  for (const file of files.filter(isLockfile)) {
    const current = (await scanLockfile(bin, join(cwd, file), cwd, signal)).map((f) => ({ ...f, file }));
    if (!current.length) continue;

    // Only vulnerabilities this build introduced: subtract the base lockfile's.
    let baseKeys = new Set<string>();
    if (baseRef) {
      const old = await git(['show', `${baseRef}:${file}`], cwd);
      if (old.code === 0) {
        const dir = mkdtempSync(join(tmpdir(), 'vtl-osv-'));
        try {
          const copy = join(dir, basename(file));
          writeFileSync(copy, old.stdout);
          baseKeys = new Set((await scanLockfile(bin, copy, cwd, signal)).map((f) => f.key));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    findings.push(...current.filter((f) => !baseKeys.has(f.key)));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Semgrep
// ---------------------------------------------------------------------------

interface SemgrepOutput {
  results?: {
    check_id?: string;
    path?: string;
    start?: { line?: number; col?: number };
    extra?: { message?: string; severity?: string };
  }[];
}

/** Parse Semgrep JSON: one finding per ERROR result (the scan is run with --severity ERROR, but check anyway). */
export function parseSemgrep(json: string): GateFinding[] {
  let out: SemgrepOutput;
  try {
    out = JSON.parse(json || '{}');
  } catch {
    return [];
  }
  const findings: GateFinding[] = [];
  for (const r of out.results ?? []) {
    if ((r.extra?.severity ?? 'ERROR').toUpperCase() !== 'ERROR') continue;
    const rule = r.check_id ?? 'semgrep';
    const file = r.path;
    const line = r.start?.line;
    const message = (r.extra?.message ?? '').trim().split('\n')[0];
    findings.push({
      gate: 'semgrep',
      key: `semgrep:${rule}:${file ?? ''}:${line ?? 0}`,
      title: message ? `${rule}: ${message}` : rule,
      file,
      line,
    });
  }
  return dedupe(findings);
}

/** A rules download that failed: no network, a registry outage. Skipped with the reason, never a failure. */
class SemgrepUnavailable extends Error {}

const NETWORK_ERROR = /network|registry|download|connection|resolve host|timed out while|semgrep\.dev|ssl|proxy|offline/i;

async function runSemgrep(bin: string, cwd: string, files: string[], timeoutMs: number, signal?: AbortSignal): Promise<GateFinding[]> {
  const existing = files.filter((f) => existsSync(join(cwd, f)));
  if (!existing.length) return [];
  const result = await runProcess(
    bin,
    ['scan', '--config', 'auto', '--severity', 'ERROR', '--json', '--quiet', '--metrics=off', '--', ...existing],
    { cwd, signal, timeoutMs, env: { ...withoutGitLocation(), PATH: searchPath(), SEMGREP_SEND_METRICS: 'off' } },
  );
  // 0: clean or findings (without --error); 1: findings with --error. Anything else is a problem.
  if (!result.aborted && !result.timedOut && !result.error && result.code !== 0 && result.code !== 1) {
    const detail = result.stderr.trim().split('\n').filter(Boolean).pop() ?? '';
    if (NETWORK_ERROR.test(result.stderr)) throw new SemgrepUnavailable(`Semgrep could not fetch its rules (network or registry): ${detail}`);
  }
  assertRan(result, 'Semgrep', [0, 1]);
  return parseSemgrep(result.stdout);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function formatGateReport(report: GateReport): string {
  const lines = ['# Security gates', ''];
  lines.push(
    report.findings.length
      ? `**Status: BLOCKED** — ${report.findings.length} finding(s) must be fixed before QA can approve.`
      : '**Status: CLEAR**',
    '',
    `Ran: ${report.ran.length ? report.ran.join(', ') : 'none'}`,
  );
  for (const s of report.skipped) lines.push(`Skipped ${s.gate}: ${s.reason}`);
  if (report.findings.length) {
    lines.push('', '## Findings', '');
    for (const f of report.findings) {
      const where = f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
      lines.push(`- [${f.gate}] ${f.title}${where}${f.detail ? `. ${f.detail}` : ''}`);
    }
    lines.push(
      '',
      '## How to fix',
      '',
      '- Secrets: remove the value from code and history, load it from configuration or the environment, and treat it as leaked (tell the user to rotate it).',
      '- Vulnerable dependencies: upgrade to a fixed version, or pick a different package. Re-run the tests after changing dependencies.',
      '- Semgrep findings: fix the code the rule points at (the rule id says what it is: injection, unsafe deserialization, …); do not silence the rule. Re-run the tests.',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Run one gate; a scanner failure is recorded as a skipped gate with the reason. */
async function runGate(report: GateReport, gate: GateName, scan: () => Promise<GateFinding[]>): Promise<void> {
  try {
    const findings = await scan();
    report.ran.push(gate);
    report.findings.push(...findings);
  } catch (error) {
    if (error instanceof SemgrepUnavailable) {
      report.skipped.push({ gate, reason: error.message });
      return;
    }
    if (!(error instanceof GateFailure)) throw error;
    report.skipped.push({ gate, reason: `failed — ${error.message}` });
  }
}

export async function runSecurityGates(options: GateOptions): Promise<GateReport> {
  const { projectDir, specDir, signal } = options;
  const report: GateReport = { ran: [], skipped: [], findings: [] };

  const inRepo = (await git(['rev-parse', '--is-inside-work-tree'], projectDir)).code === 0;
  if (!inRepo) {
    report.skipped.push(
      { gate: 'gitleaks', reason: 'not a git repository' },
      { gate: 'osv-scanner', reason: 'not a git repository' },
      { gate: 'semgrep', reason: 'not a git repository' },
    );
  } else {
    const baseRef = options.baseRef ?? (await resolveBaseRef(projectDir));
    report.baseRef = baseRef;
    const files = await changedFiles(projectDir, baseRef);
    const { gitleaksBin, osvScannerBin, semgrepBin } = options;

    if (gitleaksBin) {
      await runGate(report, 'gitleaks', () => runGitleaks(gitleaksBin, projectDir, baseRef, files, signal));
    } else {
      report.skipped.push({ gate: 'gitleaks', reason: 'gitleaks is not available' });
    }

    if (!osvScannerBin) {
      report.skipped.push({ gate: 'osv-scanner', reason: 'OSV-Scanner is not available' });
    } else if (!files.some(isLockfile)) {
      report.skipped.push({ gate: 'osv-scanner', reason: 'no dependency lockfiles changed' });
    } else {
      await runGate(report, 'osv-scanner', () => runOsv(osvScannerBin, projectDir, baseRef, files, signal));
    }

    if (!semgrepBin) {
      report.skipped.push({ gate: 'semgrep', reason: 'Semgrep is not installed' });
    } else if (!files.length) {
      report.skipped.push({ gate: 'semgrep', reason: 'no files changed' });
    } else {
      await runGate(report, 'semgrep', () => runSemgrep(semgrepBin, projectDir, files, options.semgrepTimeoutMs ?? SEMGREP_TIMEOUT_MS, signal));
    }
  }

  try {
    await writeFileReplacing(join(specDir, 'security_gates.json'), JSON.stringify(report, null, 2), 'utf-8');
    await writeFileReplacing(join(specDir, 'security_gates.md'), formatGateReport(report), 'utf-8');
  } catch {
    // Non-fatal: the gate result is still returned to the orchestrator.
  }
  return report;
}
