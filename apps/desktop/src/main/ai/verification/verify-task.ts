/**
 * The app runs a task's checks itself, on a clean copy of what is committed, and
 * reads the real exit codes. An agent saying "tests pass" is not evidence: agents
 * misreport, and they can change the tests. Whether a failure counts comes from
 * running the same check on the commit the task started from. The commands come
 * from that commit too, so a task can't choose what checks it.
 *
 * This runs code from the task's branch, outside the hooks agents work under, as an
 * agent's own `pnpm test` would. So the environment is a short list, without keys.
 * It is no sandbox. No Electron imports: this runs in the worker too.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { runProcess, searchPath } from '../../platform/exec';
import { gitRunner, type GitRun } from '../merge/git-merge';
import { type Check, type DetectedChecks, detectChecks } from './detect-checks';

export type CheckOutcome = 'passed' | 'failed' | 'timed_out' | 'unavailable';

export interface CheckResult extends Check {
  outcome: CheckOutcome;
  exitCode?: number;
  /** The end of its output */
  tail?: string;
  /** Failed, then passed when run again */
  flaky?: boolean;
  /** The same check on the commit the task started from, when it failed here */
  onBase?: CheckOutcome;
}

export interface TamperFinding {
  kind: 'deleted_test' | 'disabled_test' | 'changed_script';
  file: string;
  detail: string;
}

export interface VerificationReport {
  /**
   * passed: every check ran and passed. regression: the task broke one, or changed
   * the tests. not_verified: some check says nothing about the task (it fails on the
   * base too, its tool is missing, it ran out of time). not_configured: nothing to run.
   */
  status: 'passed' | 'regression' | 'not_verified' | 'not_configured';
  commit: string;
  baseCommit: string;
  checks: CheckResult[];
  tamper: TamperFinding[];
  /** Changed files that decide how checks run. Often fine, so not blocking; the reviewer gets to look. */
  runnerConfigChanged: string[];
}

export interface VerifyTaskOptions {
  worktreePath: string;
  baseRef: string;
  /** From the project's settings, replacing the detected checks. Not from the repository. */
  commands?: string[];
  /** The project's own variables, such as a test database */
  env: Record<string, string>;
  /** Shared by a project's tasks: they may use one test database */
  lockDir: string;
  /** What a run already learned about the base, kept between runs */
  baseResults?: Map<string, CheckOutcome>;
  /** Instead of detecting from the base. For tests. */
  detected?: DetectedChecks;
  checkTimeoutMs?: number;
  killGraceMs?: number;
  installTimeoutMs?: number;
  git?: string;
  hostEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
}

const CHECK_TIMEOUT_MS = 20 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const TAIL_CHARS = 4000;
const LOCK_POLL_MS = 5000;
const LOCK_STALE_MS = 90 * 60_000;

/** What tools need to run. Everything else, keys included, stays out. */
const KEPT_ENV = /^(HOME|USER|LOGNAME|SHELL|TERM|TMPDIR|LANG|LC_[A-Z]+|JAVA_HOME|GOPATH|GOROOT|GOMODCACHE|CARGO_HOME|RUSTUP_HOME|DOTNET_ROOT|GEM_HOME|GEM_PATH|BUNDLE_PATH|COMPOSER_HOME|PNPM_HOME|NVM_DIR|VOLTA_HOME|PYENV_ROOT|UV_CACHE_DIR|DEVELOPER_DIR)$/;

/** A project's check settings, or nothing when they are off. Pure. */
export function projectVerification(projectPath: string, settings: { verifyEnabled?: boolean; verifyCommands?: string[]; verifyEnv?: Record<string, string> } | undefined): { commands?: string[]; env: Record<string, string>; lockDir: string } | undefined {
  if (settings?.verifyEnabled === false) return undefined;
  return { commands: settings?.verifyCommands, env: settings?.verifyEnv ?? {}, lockDir: join(projectPath, '.vibe-teamlead', 'verify.lock') };
}

/** Pure. */
export function verificationEnv(host: NodeJS.ProcessEnv, project: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(host)) if (KEPT_ENV.test(name)) env[name] = value;
  return { ...env, PATH: searchPath(host.PATH?.split(delimiter)), CI: 'true', ...project };
}

/** One at a time, across the worker threads of a project's tasks. A directory: creating one is atomic. */
export async function withVerifyLock<T>(dir: string, work: () => Promise<T>, options: { pollMs?: number; staleMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const { pollMs = LOCK_POLL_MS, staleMs = LOCK_STALE_MS, signal } = options;
  for (;;) {
    try {
      mkdirSync(dir, { recursive: false });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        mkdirSync(join(dir, '..'), { recursive: true });
        continue;
      }
      if (code !== 'EEXIST') throw error;
      const since = statSync(dir, { throwIfNoEntry: false })?.mtimeMs;
      if (since !== undefined && Date.now() - since >= staleMs) {
        // Left by a run that died: a live one finishes well inside this time
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (signal?.aborted) throw new Error('Stopped while waiting for another task\'s checks');
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TEST_FILE = /(^|\/)(__tests__|tests?|Tests|specs?)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_(test|spec)\.(go|py|rb)$|[^/]*(Test|Tests|Spec)\.(java|kt|kts|cs|fs|php|swift|groovy|scala)$/;
const DISABLED = /(?<![.\w])(?:it|test|describe|context|suite)\.(?:skip|only|todo|skipIf)\b|(?<![.\w])(?:xit|xdescribe|xtest|xcontext|fit|fdescribe)[\s(]|@pytest\.mark\.(?:skip|xfail)|pytest\.skip\(|@unittest\.skip|\bt\.Skip(?:Now|f)?\(|#\[ignore|@Disabled\b|@Ignore\b|\[Ignore\b|\[(?:Fact|Theory)\(Skip|markTestSkipped|markTestIncomplete|XCTSkip|@pending\b/;
const GUARDED_SCRIPTS = ['test', 'typecheck'];
const RUNNER_CONFIG = /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|\.mocharc[^/]*|\.rspec|conftest\.py|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|Makefile|Rakefile|phpunit\.xml(\.dist)?|pom\.xml|mvnw|gradlew|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|Directory\.Build\.props|Cargo\.toml|go\.mod|Package\.swift|(vitest|vite|jest|playwright|karma)\.config\.[^/]+)$/;

function scriptsOf(text: string): Record<string, unknown> {
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
    return scripts && typeof scripts === 'object' ? (scripts as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What the task did to its tests, from git: nothing an agent says comes into it. */
async function findTamper(run: GitRun, base: string, head: string): Promise<TamperFinding[]> {
  const findings: TamperFinding[] = [];
  const list = async (args: string[], paths: string[] = []) => (await run(['-c', 'core.quotepath=off', 'diff', ...args, base, head, '--', ...paths])).raw.split('\0').filter(Boolean);

  for (const file of await list(['--diff-filter=D', '-M', '--name-only', '-z'])) {
    if (TEST_FILE.test(file)) findings.push({ kind: 'deleted_test', file, detail: 'The task deleted this test file.' });
  }

  // A rename out of where tests live takes the test out of the run just as deleting it would
  const renames = await list(['--diff-filter=R', '-M', '--name-status', '-z']);
  for (let index = 0; index + 2 < renames.length; index += 3) {
    if (TEST_FILE.test(renames[index + 1]) && !TEST_FILE.test(renames[index + 2])) {
      findings.push({ kind: 'deleted_test', file: renames[index + 1], detail: `The task moved this test to ${renames[index + 2]}, where it won't run as a test.` });
    }
  }

  // File by file: in one patch, an added line can read as the header of another file
  for (const file of (await list(['--diff-filter=AMR', '-M', '--name-only', '-z'])).filter((name) => TEST_FILE.test(name))) {
    const patch = (await run(['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', base, head, '--', file])).raw;
    const lines = patch.split('\n');
    const added = lines.slice(lines.findIndex((line) => line.startsWith('@@'))).filter((line) => line.startsWith('+'));
    const switchedOff = added.find((line) => DISABLED.test(line));
    if (switchedOff) findings.push({ kind: 'disabled_test', file, detail: `The task switched a test off or narrowed the run: ${switchedOff.slice(1).trim().slice(0, 120)}` });
  }

  for (const file of await list(['--diff-filter=M', '--name-only', '-z'], ['package.json', '*/package.json', 'composer.json'])) {
    const before = await run(['show', `${base}:${file}`]);
    const after = await run(['show', `${head}:${file}`]);
    const changed = GUARDED_SCRIPTS.filter((script) => scriptsOf(before.raw)[script] !== undefined && scriptsOf(before.raw)[script] !== scriptsOf(after.raw)[script]);
    if (changed.length) findings.push({ kind: 'changed_script', file, detail: `The task changed the "${changed.join('", "')}" script.` });
  }
  return findings;
}

async function detectAt(run: GitRun, commit: string): Promise<DetectedChecks> {
  const files = (await run(['ls-tree', '-r', '-z', '--name-only', commit])).raw.split('\0').filter(Boolean);
  const contents = new Map<string, string | null>();
  // The manifests detection reads are all at the root
  for (const file of files.filter((name) => !name.includes('/') && name.endsWith('.json'))) {
    const shown = await run(['show', `${commit}:${file}`]);
    contents.set(file, shown.ok ? shown.raw : null);
  }
  return detectChecks({ files, read: (path) => contents.get(path) ?? null });
}

export async function verifyTask(options: VerifyTaskOptions): Promise<VerificationReport> {
  return withVerifyLock(options.lockDir, () => verifyNow(options), { signal: options.signal });
}

async function verifyNow(options: VerifyTaskOptions): Promise<VerificationReport> {
  const { worktreePath, baseRef, signal, onLog, git = 'git', baseResults = new Map<string, CheckOutcome>() } = options;
  const hostEnv = options.hostEnv ?? process.env;
  const run = gitRunner(worktreePath, git, hostEnv);
  const commit = (await run(['rev-parse', 'HEAD'])).stdout;
  const baseCommit = (await run(['merge-base', baseRef, commit])).stdout;
  if (!commit || !baseCommit) throw new Error(`The task's commit or its base "${baseRef}" was not found.`);

  const detected = options.detected ?? (await detectAt(run, baseCommit));
  const checks: Check[] = options.commands?.length
    ? options.commands.map((command) => ({ name: command, command }))
    : detected.checks;
  const tamper = await findTamper(run, baseCommit, commit);
  const runnerConfigChanged = (await run(['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', baseCommit, commit])).raw.split('\0').filter((file) => RUNNER_CONFIG.test(file)).sort();
  if (!checks.length) return { status: tamper.length ? 'regression' : 'not_configured', commit, baseCommit, checks: [], tamper, runnerConfigChanged };

  const env = verificationEnv(hostEnv, options.env);
  const shell = async (command: string, cwd: string, timeoutMs: number): Promise<Omit<CheckResult, keyof Check>> => {
    let tail = '';
    const result = await runProcess('/bin/sh', ['-c', command], {
      cwd, env, timeoutMs, signal, killGroup: true, killGraceMs: options.killGraceMs, maxOutput: 1024,
      onLine: (line) => { tail = `${tail}${line}\n`.slice(-TAIL_CHARS); },
    });
    const outcome: CheckOutcome = result.timedOut ? 'timed_out' : result.code === 0 ? 'passed' : result.code === 127 || result.code === 126 ? 'unavailable' : 'failed';
    // The tail reaches agents and saved reports: the project's own values stay out of it
    for (const value of Object.values(options.env)) if (value.length >= 4) tail = tail.split(value).join('***');
    return { outcome, exitCode: result.code, tail };
  };
  /** A clean copy of a commit, gone afterwards */
  const inCopy = async <T>(at: string, work: (cwd: string) => Promise<T>): Promise<T> => {
    const parent = mkdtempSync(join(tmpdir(), 'vibe-teamlead-verify-'));
    const cwd = join(parent, 'copy');
    try {
      const cloned = await run(['clone', '-q', '--no-hardlinks', '--no-checkout', worktreePath, cwd]);
      if (!cloned.ok) throw new Error(cloned.output || 'git clone failed');
      const checkedOut = await run(['checkout', '-q', '--detach', at], cwd);
      if (!checkedOut.ok) throw new Error(checkedOut.output || 'git checkout failed');
      return await work(cwd);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  };
  const installTimeout = options.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
  const checkTimeout = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  /** The first install that fails, if any */
  const install = async (cwd: string): Promise<CheckResult | undefined> => {
    for (const command of detected.install) {
      onLog?.(`Checks: ${command}`);
      const result = await shell(command, cwd, installTimeout);
      if (result.outcome !== 'passed') return { name: 'install', command, ...result };
    }
    return undefined;
  };

  const results = await inCopy(commit, async (cwd) => {
    const failedInstall = await install(cwd);
    if (failedInstall) return [failedInstall];
    const done: CheckResult[] = [];
    for (const check of checks) {
      onLog?.(`Checks: ${check.command}`);
      let result = await shell(check.command, cwd, checkTimeout);
      let flaky = false;
      if (result.outcome === 'failed') {
        const again = await shell(check.command, cwd, checkTimeout);
        if (again.outcome === 'passed') {
          flaky = true;
          result = again;
        }
      }
      done.push({ ...check, ...result, ...(flaky ? { flaky } : {}) });
    }
    return done;
  });

  // Exit codes come from the task's code, so "tool missing" or a timeout proves nothing by itself: only the base can tell
  const failed = results.filter((result) => result.outcome !== 'passed');
  const unknown = failed.filter((result) => !baseResults.has(`${baseCommit}\0${result.command}`));
  if (unknown.length) {
    await inCopy(baseCommit, async (cwd) => {
      const failedInstall = await install(cwd);
      for (const result of unknown) {
        const key = `${baseCommit}\0${result.command}`;
        if (result.name === 'install') baseResults.set(key, failedInstall?.command === result.command ? failedInstall.outcome : 'passed');
        else baseResults.set(key, failedInstall ? failedInstall.outcome : (await shell(result.command, cwd, checkTimeout)).outcome);
      }
    });
  }
  for (const result of failed) result.onBase = baseResults.get(`${baseCommit}\0${result.command}`);

  const broke = failed.some((result) => result.onBase === 'passed');
  const status = broke || tamper.length ? 'regression' : results.every((result) => result.outcome === 'passed') ? 'passed' : 'not_verified';
  return { status, commit, baseCommit, checks: results, tamper, runnerConfigChanged };
}

const OUTCOME_WORDS: Record<CheckOutcome, string> = { passed: 'passed', failed: 'FAILED', timed_out: 'ran out of time', unavailable: 'its tool is not installed' };

/** One line per check, for the task's log and for the QA reviewer: facts it need not check again. Pure. */
export function describeVerification(report: VerificationReport): string {
  const runner = report.runnerConfigChanged.length ? [`The task also changed files that decide how checks run, so look at these before trusting a pass: ${report.runnerConfigChanged.join(', ')}`] : [];
  if (report.status === 'not_configured' && !report.tamper.length) return ['The app found no checks to run for this project, so it verified nothing.', ...runner].join('\n');
  const lines = report.checks.map((check) => {
    const base = check.onBase === undefined ? '' : check.onBase === 'passed' ? ' (passes on the base: this task broke it)' : ' (the same on the base: says nothing about this task)';
    return `- ${check.command}: ${OUTCOME_WORDS[check.outcome]}${check.exitCode === undefined ? '' : ` (exit ${check.exitCode})`}${check.flaky ? ' (failed once, then passed: flaky)' : ''}${base}`;
  });
  return [`The app ran these itself on a clean copy of commit ${report.commit.slice(0, 8)}:`, ...lines, ...report.tamper.map((finding) => `- ${finding.file}: ${finding.detail}`), ...runner].join('\n');
}

/** What must be fixed before a review can pass. Keys ignore the wording, to compare rounds. Pure. */
export function verificationIssues(report: VerificationReport): { key: string; type: 'critical'; title: string; description: string; location?: string; fix_required: string }[] {
  return [
    ...report.checks.filter((check) => check.outcome !== 'passed' && check.onBase === 'passed').map((check) => ({
      key: `check:${check.command}`,
      type: 'critical' as const,
      title: `\`${check.command}\` ${check.outcome === 'timed_out' ? 'runs out of time' : 'fails'} on this task and passes on the commit it started from`,
      description: `Exit code ${check.exitCode}. The end of its output:\n${check.tail ?? ''}`,
      fix_required: 'Fix the code so that this passes. Commit it: the app checks what is committed, on a clean copy.',
    })),
    ...report.tamper.map((finding) => ({
      key: `tamper:${finding.kind}:${finding.file}`,
      type: 'critical' as const,
      title: `Tests changed: ${finding.file}`,
      description: finding.detail,
      location: finding.file,
      fix_required: 'Put the test back and make the code pass it. If it really had to change, leave it: the user decides.',
    })),
  ];
}
