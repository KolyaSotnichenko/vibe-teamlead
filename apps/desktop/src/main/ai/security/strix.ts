/**
 * Security QA with Strix (https://github.com/usestrix/strix, Apache-2.0).
 *
 * Strix is an autonomous pentest agent: it runs the app in a Docker sandbox
 * and tries to exploit it. Vibe Teamlead runs it after QA approves, in
 * headless diff mode (only what this task changed), with a spend cap.
 *
 * Strix is an optional integration, not bundled: it needs Docker and its own
 * install (`uv tool install strix-agent` or the official installer). When
 * either is missing, or no API key is available (a claude.ai subscription
 * token cannot drive Strix), the stage is skipped with a clear reason.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { findOnPath, runProcess, searchPath } from '../../platform/exec';
import { isSubscriptionToken } from '../claude-code/auth';

export type StrixScanMode = 'quick' | 'standard' | 'deep';
export type StrixSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface StrixSettings {
  enabled: boolean;
  scanMode: StrixScanMode;
  /** Minimum severity that blocks the task */
  failOn: StrixSeverity;
  /** Maximum LLM spend per scan, USD */
  maxBudgetUsd: number;
}

const STRIX_TIMEOUT_MS: Record<StrixScanMode, number> = {
  quick: 60 * 60 * 1000,
  standard: 3 * 60 * 60 * 1000,
  deep: 8 * 60 * 60 * 1000,
};

export const DEFAULT_STRIX_SETTINGS: StrixSettings = {
  enabled: false,
  scanMode: 'quick',
  failOn: 'high',
  maxBudgetUsd: 5,
};

export interface StrixFinding {
  ruleId: string;
  title: string;
  severity: StrixSeverity | 'unknown';
  location?: string;
  description?: string;
}

export type StrixStatus = 'clear' | 'findings' | 'skipped' | 'error' | 'cancelled';

export interface StrixResult {
  status: StrixStatus;
  reason?: string;
  findings: StrixFinding[];
  /** Strix run directory (reports, per-finding markdown, SARIF) */
  runDir?: string;
  costUsd?: number;
}

export interface StrixRunOptions {
  projectDir: string;
  specDir: string;
  settings: StrixSettings;
  /** Anthropic model id, e.g. claude-sonnet-4-6 */
  model: string;
  apiKey?: string;
  baseURL?: string;
  /** Branch or commit to diff against */
  diffBase?: string;
  strixBin?: string;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}

/** Where Strix's own installer puts the binary, besides the usual PATH locations. */
function strixPath(): string {
  return searchPath([join(homedir(), '.strix', 'bin')]);
}

export async function dockerAvailable(signal?: AbortSignal): Promise<boolean> {
  const path = strixPath();
  const docker = findOnPath('docker', path);
  if (!docker) return false;
  const result = await runProcess(docker, ['info'], { env: { ...process.env, PATH: path }, timeoutMs: 15_000, signal });
  return result.code === 0;
}

export function buildStrixArgs(options: Pick<StrixRunOptions, 'projectDir' | 'settings' | 'diffBase'>, instructionFile: string): string[] {
  const args = [
    '--non-interactive',
    '--target',
    options.projectDir,
    '--scan-mode',
    options.settings.scanMode,
    '--scope-mode',
    'diff',
    '--fail-on',
    options.settings.failOn,
    '--max-budget',
    String(options.settings.maxBudgetUsd),
    '--instruction-file',
    instructionFile,
  ];
  if (options.diffBase) args.push('--diff-base', options.diffBase);
  return args;
}

/** LiteLLM model id for an Anthropic model. */
export function strixModel(model: string): string {
  return model.includes('/') ? model : `anthropic/${model}`;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const SEVERITIES: StrixSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function toSeverity(value: unknown): StrixSeverity | undefined {
  const v = String(value ?? '').toLowerCase();
  return (SEVERITIES as string[]).includes(v) ? (v as StrixSeverity) : undefined;
}

/** SARIF level / security-severity → severity. */
function sarifSeverity(result: Record<string, unknown>, rule?: Record<string, unknown>): StrixSeverity | 'unknown' {
  const props = { ...(rule?.properties as object), ...(result.properties as object) } as Record<string, unknown>;
  const named = toSeverity(props.severity) ?? toSeverity(props['problem.severity']);
  if (named) return named;
  const score = Number(props['security-severity']);
  if (!Number.isNaN(score) && props['security-severity'] !== undefined) {
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    if (score > 0) return 'low';
    return 'info';
  }
  switch (result.level) {
    case 'error':
      return 'high';
    case 'warning':
      return 'medium';
    case 'note':
      return 'low';
    default:
      return 'unknown';
  }
}

export function parseSarif(json: string): StrixFinding[] {
  let sarif: { runs?: { tool?: { driver?: { rules?: Record<string, unknown>[] } }; results?: Record<string, unknown>[] }[] };
  try {
    sarif = JSON.parse(json);
  } catch {
    return [];
  }
  const findings: StrixFinding[] = [];
  for (const run of sarif.runs ?? []) {
    const rules = run.tool?.driver?.rules ?? [];
    for (const result of run.results ?? []) {
      const ruleId = String(result.ruleId ?? 'finding');
      const rule = rules.find((r) => r.id === ruleId) ?? rules[Number(result.ruleIndex)];
      const message = (result.message as { text?: string } | undefined)?.text;
      const loc = (result.locations as { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }[] | undefined)?.[0]
        ?.physicalLocation;
      const location = loc?.artifactLocation?.uri ? `${loc.artifactLocation.uri}${loc.region?.startLine ? `:${loc.region.startLine}` : ''}` : undefined;
      const shortDesc = (rule?.shortDescription as { text?: string } | undefined)?.text ?? (rule?.name as string | undefined);
      findings.push({
        ruleId,
        title: shortDesc || message?.split('\n')[0] || ruleId,
        severity: sarifSeverity(result, rule),
        location,
        description: message,
      });
    }
  }
  return findings;
}

/** Severity at or above the threshold (unknown always counts, like Strix's --fail-on). */
export function isBlocking(finding: StrixFinding, failOn: StrixSeverity): boolean {
  if (finding.severity === 'unknown') return true;
  return SEVERITIES.indexOf(finding.severity) <= SEVERITIES.indexOf(failOn);
}

function latestRunDir(workDir: string): string | undefined {
  const runs = join(workDir, 'strix_runs');
  if (!existsSync(runs)) return undefined;
  const dirs = readdirSync(runs)
    .map((name) => join(runs, name))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0];
}

function readRunCost(runDir: string): number | undefined {
  try {
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8')) as { llm_usage?: { cost?: number } };
    return typeof run.llm_usage?.cost === 'number' ? run.llm_usage.cost : undefined;
  } catch {
    return undefined;
  }
}

export function formatStrixReport(result: StrixResult, settings: StrixSettings, specDir: string): string {
  const lines = ['# Security QA (Strix)', ''];
  const blocking = result.findings.filter((f) => isBlocking(f, settings.failOn));
  switch (result.status) {
    case 'findings':
      lines.push(`**Status: BLOCKED** — ${blocking.length} finding(s) at ${settings.failOn} or above.`);
      break;
    case 'clear':
      lines.push(`**Status: CLEAR** — no findings at ${settings.failOn} or above.`);
      break;
    default:
      lines.push(`**Status: ${result.status.toUpperCase()}**${result.reason ? ` — ${result.reason}` : ''}`);
  }
  lines.push('', `Scan: ${settings.scanMode}, changed code only, budget $${settings.maxBudgetUsd}${result.costUsd !== undefined ? `, spent $${result.costUsd.toFixed(2)}` : ''}`);
  if (result.runDir) lines.push(`Full report: \`${relative(specDir, result.runDir)}/penetration_test_report.md\``);
  if (result.findings.length) {
    lines.push('', '## Findings', '');
    for (const f of result.findings) {
      lines.push(`- **[${f.severity}] ${f.title}**${f.location ? ` — \`${f.location}\`` : ''}${isBlocking(f, settings.failOn) ? '' : ' (below threshold)'}`);
      if (f.description && f.description !== f.title) lines.push(`  ${f.description.split('\n').join('\n  ')}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Fix request for the QA fixer (consumed through QA_FIX_REQUEST.md). */
export function formatFixRequest(result: StrixResult, settings: StrixSettings, specDir: string): string {
  const blocking = result.findings.filter((f) => isBlocking(f, settings.failOn));
  const lines = [
    '# Security QA findings (Strix)',
    '',
    'Strix, an automated penetration test, confirmed these vulnerabilities in the code this task changed. Fix each one:',
    '',
    '1. Write a failing test that reproduces the exploit (use the proof of concept in the report).',
    '2. Fix the root cause, not the symptom.',
    '3. Run the full test suite.',
    '',
  ];
  if (result.runDir) lines.push(`Details and proofs of concept: \`${relative(specDir, result.runDir)}/vulnerabilities/\``, '');
  for (const f of blocking) {
    lines.push(`## [${f.severity}] ${f.title}`, '');
    if (f.location) lines.push(`Location: \`${f.location}\``, '');
    if (f.description) lines.push(f.description, '');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runStrix(options: StrixRunOptions): Promise<StrixResult> {
  const { settings, specDir, signal } = options;
  const workDir = join(specDir, 'security');
  const finish = async (result: StrixResult): Promise<StrixResult> => {
    try {
      await writeFile(join(specDir, 'security_qa.json'), JSON.stringify({ ...result, settings }, null, 2), 'utf-8');
      await writeFile(join(specDir, 'security_qa.md'), formatStrixReport(result, settings, specDir), 'utf-8');
    } catch {
      // Non-fatal
    }
    return result;
  };

  if (!options.apiKey || isSubscriptionToken(options.apiKey)) {
    return finish({ status: 'skipped', reason: 'Strix needs an Anthropic API key (a Claude subscription cannot be used for it)', findings: [] });
  }
  const strix = options.strixBin ?? findOnPath('strix', strixPath());
  if (!strix) {
    return finish({ status: 'skipped', reason: 'Strix is not installed (uv tool install strix-agent)', findings: [] });
  }
  if (!(await dockerAvailable(signal))) {
    if (signal?.aborted) return finish({ status: 'cancelled', findings: [] });
    return finish({ status: 'skipped', reason: 'Docker is not running', findings: [] });
  }
  if (signal?.aborted) return finish({ status: 'cancelled', findings: [] });

  mkdirSync(workDir, { recursive: true });
  const instructionFile = join(workDir, 'instructions.md');
  await writeFile(
    instructionFile,
    [
      'This is a white-box test of a feature branch built by an AI team. Test only what changed.',
      `The feature specification (with acceptance criteria) is at ${join(specDir, 'spec.md')}; the architecture, if any, is under ${join(specDir, 'architecture')}.`,
      'Report only vulnerabilities you can demonstrate with a proof of concept. Do not modify the source code.',
    ].join('\n'),
    'utf-8',
  );

  const env: NodeJS.ProcessEnv = {
    PATH: strixPath(),
    HOME: process.env.HOME ?? homedir(),
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    DOCKER_HOST: process.env.DOCKER_HOST,
    STRIX_LLM: strixModel(options.model),
    LLM_API_KEY: options.apiKey,
    ...(options.baseURL ? { LLM_API_BASE: options.baseURL } : {}),
    STRIX_TELEMETRY: '0',
  };

  options.onLog?.(`Security QA: Strix ${settings.scanMode} scan of changed code (budget $${settings.maxBudgetUsd})`);
  const run = await runProcess(strix, buildStrixArgs(options, instructionFile), {
    cwd: workDir,
    env,
    signal,
    // A deep scan can take hours; the budget cap is the real limit.
    timeoutMs: STRIX_TIMEOUT_MS[settings.scanMode],
    maxOutput: 1024 * 1024,
    onLine: (line) => options.onLog?.(`[strix] ${line.trim()}`),
  });
  const code: number | 'cancelled' = run.aborted ? 'cancelled' : run.timedOut ? -2 : run.code;

  if (code === 'cancelled') return finish({ status: 'cancelled', findings: [] });

  const runDir = latestRunDir(workDir);
  const sarifPath = runDir ? join(runDir, 'findings.sarif') : undefined;
  const findings = sarifPath && existsSync(sarifPath) ? parseSarif(readFileSync(sarifPath, 'utf-8')) : [];
  const costUsd = runDir ? readRunCost(runDir) : undefined;

  if (code === 0) return finish({ status: 'clear', findings, runDir, costUsd });
  if (code === 2) {
    const blocking = findings.filter((f) => isBlocking(f, settings.failOn));
    // Exit 2 with an unreadable report still blocks: send the fixer to the run directory.
    return finish({
      status: 'findings',
      findings: blocking.length ? findings : [{ ruleId: 'strix', title: 'Strix reported vulnerabilities (see the run report)', severity: 'unknown' }, ...findings],
      runDir,
      costUsd,
    });
  }
  const reason = code === -2 ? 'Strix timed out' : run.error ? `Strix could not start: ${run.error}` : `Strix exited with code ${code}`;
  return finish({ status: 'error', reason, findings, runDir, costUsd });
}
