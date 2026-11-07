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
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

import { runProcess, searchPath } from '../../platform/exec';
import type { VerificationSummary } from '../../../shared/utils/verification-summary';
import { gitRunner, type GitRun } from '../merge/git-merge';
import { type Check, type DetectedChecks, detectChecks, namesDatabase, type ServiceImage, serviceEnv, serviceImages } from './detect-checks';
import { type DockerRun, hostDocker, startTestServices } from './test-services';

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
  /** The end of its output there, when it failed there too */
  tailOnBase?: string;
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
  /** The temporary databases the checks ran against, or why there were none */
  services?: { status: 'started' | 'unavailable'; images: string[]; reason?: string };
  /** The project has migrations and they weren't run: no temporary database to run them on */
  migrationsSkipped?: boolean;
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
  /** Instead of the machine's docker. For tests. */
  docker?: DockerRun;
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
/** Narrows the whole run, wherever it is */
const NARROWED = /(?<![.\w])(?:it|test|describe|context|suite)\.only\b|(?<![.\w])(?:fit|fdescribe)[\s(]/;
/** Switches off a test that was running. A condition on a resource isn't that: `describe.skipIf(!DB)` runs when the resource is there. */
const DISABLED = /(?<![.\w])(?:it|test|describe|context|suite)\.(?:skip|only|todo)\b|\.skipIf\(\s*true\s*\)|(?<![.\w])(?:xit|xdescribe|xtest|xcontext|fit|fdescribe)[\s(]|@pytest\.mark\.(?:skip|xfail)|pytest\.skip\(|@unittest\.skip|\bt\.Skip(?:Now|f)?\(|#\[ignore|@Disabled\b|@Ignore\b|\[Ignore\b|\[(?:Fact|Theory)\(Skip|markTestSkipped|markTestIncomplete|XCTSkip|@pending\b/;
/** `DB ? describe : describe.skip`: chosen at run time, as with skipIf */
const CONDITIONAL_SKIP = /\?\s*[\w.]+\s*:\s*(?:it|test|describe|context|suite)\.skip\b/;
const GUARDED_SCRIPTS = ['test', 'typecheck'];

/** A line without its comment: words in a comment switch nothing off. `#[` is Rust code, not a comment. Pure. */
function codeOf(line: string): string {
  if (/^\s*(\/\/|\/\*|\*|--|#(?!\[))/.test(line)) return '';
  return line.replace(/\s\/\/.*$/, '');
}
const RUNNER_CONFIG = /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|\.mocharc[^/]*|\.rspec|conftest\.py|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|Makefile|Rakefile|phpunit\.xml(\.dist)?|pom\.xml|mvnw|gradlew|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|Directory\.Build\.props|Cargo\.toml|go\.mod|Package\.swift|(vitest|vite|jest|playwright|karma)\.config\.[^/]+)$/;

function scriptsOf(text: string): Record<string, unknown> {
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
    return scripts && typeof scripts === 'object' ? (scripts as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Relative, inside the project, and nothing a tool would read as a flag or a response file */
const TEST_FILE_ARGUMENT = /^(?!.*\.\.)(\.\/)?\w[\w@./-]*\.(test|spec)\.[cm]?[jt]sx?$/;
/** Runners whose words right before a list of files mean "run these", and that start a command */
const LISTING_RUNNERS = [['node', '--test'], ['vitest', 'run'], ['mocha'], ['jest']];
const COMMAND_START = new Set(['&&', ';']);

/**
 * Whether a changed script only names more test files in a run that already names
 * its files: every other byte stays, so nothing else can come along with them. Only
 * for the plain form of a known runner: in a run that names no files, a file is a
 * filter that narrows it, and after a flag it may widen what the flag leaves out.
 * Pure.
 */
export function onlyAddsTestFiles(before: unknown, after: unknown): boolean {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const old = before.split(' ');
  const next = after.split(' ');
  const inARunnersList = (index: number) => {
    let first = index - 1;
    if (first < 0 || !TEST_FILE_ARGUMENT.test(next[first])) return false;
    while (first > 0 && TEST_FILE_ARGUMENT.test(next[first - 1])) first--;
    return LISTING_RUNNERS.some((runner) => {
      const start = first - runner.length;
      return start >= 0 && runner.every((word, offset) => next[start + offset] === word) && (start === 0 || COMMAND_START.has(next[start - 1]));
    });
  };
  let kept = 0;
  for (let index = 0; index < next.length; index++) {
    if (next[index] === old[kept]) kept++;
    else if (!TEST_FILE_ARGUMENT.test(next[index]) || !inARunnersList(index)) return false;
  }
  return kept === old.length;
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

  // A new file takes nothing away: holding back its own new test is for the reviewer, against the
  // criteria. Only narrowing the run counts there.
  const added = new Set(await list(['--diff-filter=A', '-M', '--name-only', '-z']));
  // File by file: in one patch, an added line can read as the header of another file
  for (const file of (await list(['--diff-filter=AMR', '-M', '--name-only', '-z'])).filter((name) => TEST_FILE.test(name))) {
    const patch = (await run(['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', base, head, '--', file])).raw;
    const lines = patch.split('\n');
    const addedLines = lines.slice(lines.findIndex((line) => line.startsWith('@@'))).filter((line) => line.startsWith('+')).map((line) => codeOf(line.slice(1)));
    const pattern = added.has(file) ? NARROWED : DISABLED;
    const switchedOff = addedLines.find((line) => pattern.test(line) && !CONDITIONAL_SKIP.test(line));
    if (switchedOff) findings.push({ kind: 'disabled_test', file, detail: `The task switched a test off or narrowed the run: ${switchedOff.trim().slice(0, 120)}` });
  }

  for (const file of await list(['--diff-filter=M', '--name-only', '-z'], ['package.json', '*/package.json', 'composer.json'])) {
    const before = await run(['show', `${base}:${file}`]);
    const after = await run(['show', `${head}:${file}`]);
    const changed = GUARDED_SCRIPTS.filter((script) => {
      const was = scriptsOf(before.raw)[script];
      const is = scriptsOf(after.raw)[script];
      return was !== undefined && was !== is && !onlyAddsTestFiles(was, is);
    });
    if (changed.length) findings.push({ kind: 'changed_script', file, detail: `The task changed the "${changed.join('", "')}" script.` });
  }
  return findings;
}

const COMPOSE_FILE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/;
/** At the root or one level of packages in: the example settings of a monorepo's apps */
const ENV_EXAMPLE = /^([^/]+\/){0,2}\.env\.(example|sample)$/;
/** A real env file in the repository: tools may read it before anything the app sets */
const COMMITTED_ENV = /(^|\/)\.env(\.[\w-]+)?$/;

/** All this reads from the base, so that a task can't choose what checks it or what it runs against. */
async function detectAt(run: GitRun, commit: string): Promise<{ detected: DetectedChecks; images: ServiceImage[]; example: string; committedDatabase: boolean }> {
  const files = (await run(['ls-tree', '-r', '-z', '--name-only', commit])).raw.split('\0').filter(Boolean);
  const show = async (file: string) => {
    const shown = await run(['show', `${commit}:${file}`]);
    return shown.ok ? shown.raw : '';
  };
  const contents = new Map<string, string | null>();
  // The manifests detection reads are all at the root
  for (const file of files.filter((name) => !name.includes('/') && name.endsWith('.json'))) contents.set(file, await show(file));
  const composeFile = files.find((name) => COMPOSE_FILE.test(name));
  const examples = await Promise.all(files.filter((name) => ENV_EXAMPLE.test(name)).sort().map(show));
  const committed = await Promise.all(files.filter((name) => COMMITTED_ENV.test(name) && !/\.(example|sample)$/.test(name)).map(show));
  return {
    detected: detectChecks({ files, read: (path) => contents.get(path) ?? null }),
    images: composeFile ? serviceImages(await show(composeFile)) : [],
    example: examples.join('\n'),
    committedDatabase: committed.some(namesDatabase),
  };
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

  const base = await detectAt(run, baseCommit);
  const detected = options.detected ?? base.detected;
  const checks: Check[] = options.commands?.length
    ? options.commands.map((command) => ({ name: command, command }))
    : detected.checks;
  const tamper = await findTamper(run, baseCommit, commit);
  const runnerConfigChanged = (await run(['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', baseCommit, commit])).raw.split('\0').filter((file) => RUNNER_CONFIG.test(file)).sort();
  if (!checks.length) return { status: tamper.length ? 'regression' : 'not_configured', commit, baseCommit, checks: [], tamper, runnerConfigChanged };

  const docker = options.docker ?? hostDocker(hostEnv, signal);
  const serviceLabel = basename(dirname(dirname(options.lockDir))).replace(/[^\w.-]/g, '_') || 'project';
  let services: VerificationReport['services'];
  /** Set for each copy: every copy gets its own database */
  let env: NodeJS.ProcessEnv = {};
  let secrets: string[] = [];
  /** Only ever true while this copy's own temporary database is up: migrations can destroy data */
  let migratable = false;
  let migrationsSkipped = false;
  /** The tail reaches agents and saved reports: the project's own values stay out of it */
  const redact = (line: string) => secrets.reduce((text, value) => (value.length >= 4 ? text.split(value).join('***') : text), line);
  const shell = async (command: string, cwd: string, timeoutMs: number): Promise<Omit<CheckResult, keyof Check>> => {
    let tail = '';
    const result = await runProcess('/bin/sh', ['-c', command], {
      cwd, env, timeoutMs, signal, killGroup: true, killGraceMs: options.killGraceMs, maxOutput: 1024,
      // Line by line, before the cut: a cut through a value would leave a part no match can find.
      // Best effort, not a boundary: code that means to leak a value can encode it.
      onLine: (line) => { tail = `${tail}${redact(line)}\n`.slice(-TAIL_CHARS); },
    });
    const outcome: CheckOutcome = result.timedOut ? 'timed_out' : result.code === 0 ? 'passed' : result.code === 127 || result.code === 126 ? 'unavailable' : 'failed';
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
      const started = await startTestServices(base.images, { docker, label: serviceLabel });
      try {
        if (started.status !== 'none') {
          services ??= { status: started.status, images: base.images.map((image) => image.image), ...(started.reason ? { reason: started.reason } : {}) };
        }
        const variables = { ...serviceEnv(base.example, started.started), ...options.env };
        env = verificationEnv(hostEnv, variables);
        // Set by the project's settings, an address may be anything, so migrations stay away from it
        const ownDatabase = Object.keys(options.env).some((name) => /(DATABASE|POSTGRES|MYSQL|MONGO|^DB|^PG)/i.test(name));
        // The migration tools here are for SQL databases
        migratable = !ownDatabase && !base.committedDatabase && started.started.some((service) => service.kind === 'postgres' || service.kind === 'mysql');
        // Example values aren't secrets, the project's own values and the database addresses are
        secrets = [...Object.values(options.env), ...started.started.flatMap((service) => [service.url, new URL(service.url).password])];
        return await work(cwd);
      } finally {
        await started.stop();
      }
    } finally {
      // Not the sync call: after a merge this runs in the main process, where
      // removing an installed copy froze the whole window for seconds
      await rm(parent, { recursive: true, force: true });
    }
  };
  const installTimeout = options.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
  const checkTimeout = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  /** The first install that fails, if any */
  const install = async (cwd: string): Promise<CheckResult | undefined> => {
    for (const command of detected.install) {
      onLog?.(`Checks: ${command}`);
      let result = await shell(command, cwd, installTimeout);
      // A stall says more about the machine than the task: asleep, or busy with other tasks
      if (result.outcome === 'timed_out') result = await shell(command, cwd, installTimeout);
      if (result.outcome !== 'passed') return { name: 'install', command, ...result };
    }
    if (!migratable) {
      if (detected.prepare?.length) migrationsSkipped = true;
      return undefined;
    }
    for (const command of detected.prepare ?? []) {
      onLog?.(`Checks: ${command}`);
      const result = await shell(command, cwd, installTimeout);
      if (result.outcome !== 'passed') return { name: 'prepare', command, ...result };
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
      if (result.outcome === 'failed' || result.outcome === 'timed_out') {
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
  const baseTails = new Map<string, string>();
  const unknown = failed.filter((result) => !baseResults.has(`${baseCommit}\0${result.command}`));
  if (unknown.length) {
    await inCopy(baseCommit, async (cwd) => {
      const failedInstall = await install(cwd);
      for (const result of unknown) {
        const key = `${baseCommit}\0${result.command}`;
        if (result.name === 'install' || result.name === 'prepare') baseResults.set(key, failedInstall?.command === result.command ? failedInstall.outcome : 'passed');
        else if (failedInstall) {
          baseResults.set(key, failedInstall.outcome);
          baseTails.set(key, failedInstall.tail ?? '');
        } else {
          let onBase = await shell(result.command, cwd, checkTimeout);
          // As on the task: a flaky test here would hide what the task broke
          if (onBase.outcome === 'failed') onBase = await shell(result.command, cwd, checkTimeout);
          baseResults.set(key, onBase.outcome);
          baseTails.set(key, onBase.tail ?? '');
        }
      }
    });
  }
  for (const result of failed) {
    const key = `${baseCommit}\0${result.command}`;
    result.onBase = baseResults.get(key);
    if (result.onBase !== 'passed' && baseTails.has(key)) result.tailOnBase = baseTails.get(key);
  }

  const broke = failed.some((result) => result.onBase === 'passed');
  const status = broke || tamper.length ? 'regression' : results.every((result) => result.outcome === 'passed') ? 'passed' : 'not_verified';
  return { status, commit, baseCommit, checks: results, tamper, runnerConfigChanged, ...(services ? { services } : {}), ...(migrationsSkipped ? { migrationsSkipped } : {}) };
}

/**
 * A pass the reviewer may rely on without looking further. Not when the task changed
 * what decides how checks run, or part of it didn't run. Pure.
 */
export function verificationIsConclusive(report: VerificationReport): boolean {
  return report.status === 'passed' && !report.runnerConfigChanged.length && !report.migrationsSkipped && report.services?.status !== 'unavailable';
}

/** What the task window shows. Pure. */
export function verificationSummary(report: VerificationReport): VerificationSummary {
  return {
    status: report.status,
    commit: report.commit,
    checks: report.checks.map(({ command, outcome, onBase }) => ({ command, outcome, ...(onBase ? { onBase } : {}) })),
    ...(report.services ? { services: { status: report.services.status, images: report.services.images } } : {}),
    ...(report.migrationsSkipped ? { migrationsSkipped: true } : {}),
  };
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
  if (report.migrationsSkipped) runner.push('The migrations were not run: there was no temporary database to run them on, and they could change a real one.');
  const databases = report.services?.status === 'started'
    ? [`Against a temporary, empty database: ${report.services.images.join(', ')}`]
    : report.services?.reason ? [report.services.reason] : [];
  return [`The app ran these itself on a clean copy of commit ${report.commit.slice(0, 8)}:`, ...databases, ...lines, ...report.tamper.map((finding) => `- ${finding.file}: ${finding.detail}`), ...runner].join('\n');
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
