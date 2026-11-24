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

import type { StartsWhy } from '../../../shared/utils/verification-summary';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

import { pathValue, WINDOWS_HOST_ENV } from '../../platform/env';
import { runShell, searchPath } from '../../platform/exec';
import type { VerificationSummary } from '../../../shared/utils/verification-summary';
import { gitRunner, type GitRun, withoutGitHooks } from '../merge/git-merge';
import { spawn } from 'node:child_process';
import { resolveRecipe } from '../../preview/recipe';
import { type Check, composeFilesInOrder, type DetectedChecks, detectChecks, imagesFromComposeFiles, namesDatabase, type ServiceImage, serviceEnv } from './detect-checks';
import { ago, type CheckMemory, type CheckMemoryPlace, memoryKey, openCheckMemory } from './check-memory';
import { type DockerRun, hostDocker, startTestServices, VERIFY_LABEL } from './test-services';
import { createRunNetwork, startComposeServices } from './compose-runner';
import { adapterOf, bucketsOf, type ComposeService, composeSecrets, composeServices } from './compose-services';
import { localPortFree } from '../../preview/preview-ports';
import { probeThroughPage } from '../../preview/probe';
import type { PreviewService } from '../../../shared/types/project';
import { startDevServer, stopDevServer } from '../dev-servers/dev-servers';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { STARTS_CHECK, startsCheck as realStartsCheck, type StartsCheckOptions, type StartsResult } from './starts-check';
import type { ComposeWiring } from './compose-env';
import type { StartedService } from './detect-checks';

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
  /** The start-up check: why it could not judge the task */
  why?: StartsWhy;
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
  /**
   * 'task': the base had no checks at all (a new project's first task), so the commands, installs
   * and database came from the task itself. A pass shows less than usual; a failure is the task's.
   */
  source?: 'task';
  /**
   * Set when the checks were not run this time: this is the result of an earlier run (at this
   * time) on the same commit, base, commands and settings (check-memory.ts).
   */
  fromRunAt?: string;
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
  /**
   * Where results are kept between runs and the app's key that signs them (appCheckMemory()).
   * Without it every run checks.
   */
  memory?: CheckMemoryPlace;
  /** The user asked to run the checks again: nothing kept is used, and the new result replaces it */
  fresh?: boolean;
  /** Instead of detecting from the base. For tests. */
  detected?: DetectedChecks;
  checkTimeoutMs?: number;
  killGraceMs?: number;
  /** Instead of the machine's docker. For tests. */
  docker?: DockerRun;
  /** Whether nothing on this computer holds a local port. Default: a real look. For tests. */
  hostPortFree?: (port: number) => Promise<boolean>;
  /** The project's saved preview services: what the start-up check starts when the copy has no preview.json */
  previewServices?: PreviewService[];
  /** Instead of starting the project for real. For tests. */
  startsCheck?: (options: StartsCheckOptions) => Promise<StartsResult | null>;
  /** The task's code started and passed: its page's address, while it runs (the screen check). Not for the base's run. */
  onAppUp?: (url: string) => Promise<void>;
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
/** Windows' system and user folders, under any spelling (Windows names are case-insensitive) */
const KEPT_WINDOWS_ENV = new Set<string>(WINDOWS_HOST_ENV.map((name) => name.toLowerCase()));

/** A project's check settings, or nothing when they are off. Pure. */
export function projectVerification(
  projectPath: string,
  settings: { verifyEnabled?: boolean; verifyCommands?: string[]; verifyEnv?: Record<string, string>; previewServices?: PreviewService[] } | undefined,
): { commands?: string[]; env: Record<string, string>; lockDir: string; previewServices?: PreviewService[] } | undefined {
  if (settings?.verifyEnabled === false) return undefined;
  return {
    commands: settings?.verifyCommands,
    env: settings?.verifyEnv ?? {},
    lockDir: join(projectPath, '.vibe-teamlead', 'verify.lock'),
    ...(settings?.previewServices?.length ? { previewServices: settings.previewServices } : {}),
  };
}

/** Pure. */
export function verificationEnv(host: NodeJS.ProcessEnv, project: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(host)) if (KEPT_ENV.test(name) || KEPT_WINDOWS_ENV.has(name.toLowerCase())) env[name] = value;
  return { ...env, PATH: searchPath(pathValue(host).split(delimiter).filter(Boolean)), CI: 'true', ...project };
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
const RUNNER_CONFIG = /(^|\/)(preview\.json|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|\.mocharc[^/]*|\.rspec|conftest\.py|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|Makefile|Rakefile|phpunit\.xml(\.dist)?|pom\.xml|mvnw|gradlew|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|Directory\.Build\.props|Cargo\.toml|go\.mod|Package\.swift|(vitest|vite|jest|playwright|karma)\.config\.[^/]+)$/;

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

/** At the root or one level of packages in: the example settings of a monorepo's apps */
const ENV_EXAMPLE = /^([^/]+\/){0,2}\.env\.(example|sample)$/;
/** A real env file in the repository: tools may read it before anything the app sets */
const COMMITTED_ENV = /(^|\/)\.env(\.[\w-]+)?$/;

/** All this reads from the base, so that a task can't choose what checks it or what it runs against. */
async function detectAt(run: GitRun, commit: string): Promise<{ detected: DetectedChecks; images: ServiceImage[]; compose: ComposeService[]; example: string; committedDatabase: boolean }> {
  const files = (await run(['ls-tree', '-r', '-z', '--name-only', commit])).raw.split('\0').filter(Boolean);
  const show = async (file: string) => {
    const shown = await run(['show', `${commit}:${file}`]);
    return shown.ok ? shown.raw : '';
  };
  const contents = new Map<string, string | null>();
  // The manifests detection reads are all at the root
  for (const file of files.filter((name) => !name.includes('/') && name.endsWith('.json'))) contents.set(file, await show(file));
  // The main compose file first: an override that sorts before it may name no images
  const composeContents = await Promise.all(composeFilesInOrder(files).map(show));
  const examples = await Promise.all(files.filter((name) => ENV_EXAMPLE.test(name)).sort().map(show));
  const committed = await Promise.all(files.filter((name) => COMMITTED_ENV.test(name) && !/\.(example|sample)$/.test(name)).map(show));
  return {
    detected: detectChecks({ files, read: (path) => contents.get(path) ?? null }),
    images: imagesFromComposeFiles(composeContents),
    compose: composeServices(composeContents),
    example: examples.join('\n'),
    committedDatabase: committed.some(namesDatabase),
  };
}

/** What the start-up check's outcome reads as in the task's log */
const STARTS_WORDS: Record<CheckOutcome, string> = { passed: 'started', failed: 'did not start', timed_out: 'ran out of time starting', unavailable: 'could not be judged' };

/** The files a recipe, or what the app proposes without one, is read from */
const RECIPE_INPUT = /(^|\/)(preview\.json|package\.json|pyproject\.toml|requirements\.txt|Pipfile|Gemfile|[^/]+\.py)$/;
const MAX_RECIPE_INPUTS = 2000;

/** Files of a commit, read in one git process that doesn't block: `git cat-file --batch` */
function readAt(git: string, cwd: string, env: NodeJS.ProcessEnv, commit: string, files: string[]): Promise<Map<string, string>> {
  return new Promise((resolveRead) => {
    const out = new Map<string, string>();
    if (!files.length) return resolveRead(out);
    const child = spawn(git, ['cat-file', '--batch'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolveRead(out));
    child.on('close', () => {
      const data = Buffer.concat(chunks);
      let at = 0;
      for (const file of files) {
        const end = data.indexOf(10, at);
        if (end < 0) break;
        const header = data.subarray(at, end).toString('utf-8');
        at = end + 1;
        const size = /^\S+ blob (\d+)$/.exec(header)?.[1];
        if (size === undefined) continue;
        out.set(file, data.subarray(at, at + Number(size)).toString('utf-8'));
        at += Number(size) + 1;
      }
      resolveRead(out);
    });
    child.stdin.end(files.map((file) => `${commit}:${file}`).join('\n') + '\n');
  });
}

/** A failure of the start-up check that says only that a port was taken: it is run once more */
const PORT_IN_USE = /EADDRINUSE|address already in use|port is already allocated/i;

/** Whether a commit could have something to start: a recipe, saved services, or the files a proposal reads */
async function mayStart(run: GitRun, commit: string, saved: PreviewService[] | undefined): Promise<boolean> {
  if (saved?.length) return true;
  const files = (await run(['ls-tree', '-r', '-z', '--name-only', commit])).raw.split('\0').filter(Boolean);
  return files.some((file) => /(^|\/)(preview\.json|package\.json|manage\.py|artisan|go\.mod|pyproject\.toml|requirements\.txt|Gemfile)$/.test(file));
}

/** A free local port: a server on port 0, closed at once */
function anyFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** What the start-up check starts servers with: the app's dev-server manager, with the copy's short environment */
function startsDeps(hostEnv: NodeJS.ProcessEnv, projectEnv: Record<string, string>): StartsCheckOptions['deps'] {
  return {
    startServer: (start) => {
      // As for every check: the copy's values, then the owner's. CI is for test runners: some dev servers change under it.
      const { CI: _ci, ...env } = verificationEnv(hostEnv, { ...start.env, ...projectEnv }) as Record<string, string>;
      return startDevServer({ ...start, env });
    },
    stopServer: stopDevServer,
    pickPort: anyFreePort,
    portFree: localPortFree,
    probe: probeThroughPage,
    readLog: (path) => {
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return null;
      }
    },
  };
}

/** A duration for the log: 4.2s, 1m16s */
/**
 * Whether running the same checks again could only say the same: every check ran to an exit
 * code, with the services it needs, and so did the base where it was asked. Pure.
 */
function isAnAnswer(report: VerificationReport): boolean {
  const ran = (outcome: CheckOutcome | undefined) => outcome === undefined || outcome === 'passed' || outcome === 'failed';
  // A start that failed for a port in use says something about this computer at that moment, not the commit
  const portRace = report.checks.some((check) => check.name === STARTS_CHECK.name && check.outcome === 'failed' && PORT_IN_USE.test(check.tail ?? ''));
  return !portRace && report.services?.status !== 'unavailable' && report.checks.every((check) => ran(check.outcome) && ran(check.onBase));
}

function took(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
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
  // A base with nothing to check (a new project's first task): rather than verify nothing, run what
  // the task itself sets up, and say so. The project's settings and the base still come first.
  let source: 'task' | undefined;
  let from = base;
  if (!options.commands?.length && !options.detected && !base.detected.checks.length) {
    const own = await detectAt(run, commit);
    if (own.detected.checks.length) {
      source = 'task';
      from = { ...own, images: base.images.length ? base.images : own.images, compose: base.compose.length ? base.compose : own.compose };
    }
  }
  const detected = options.detected ?? from.detected;
  const checks: Check[] = options.commands?.length
    ? options.commands.map((command) => ({ name: command, command }))
    : detected.checks;
  const tamper = await findTamper(run, baseCommit, commit);
  const runnerConfigChanged = (await run(['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', baseCommit, commit])).raw.split('\0').filter((file) => RUNNER_CONFIG.test(file)).sort();
  // Nothing to check and nothing to start: there is nothing to say
  if (!checks.length && !(await mayStart(run, commit, options.previewServices))) return { status: tamper.length ? 'regression' : 'not_configured', commit, baseCommit, checks: [], tamper, runnerConfigChanged };

  /** Progress for the task's log: these checks take minutes, and a silent log looks stuck */
  const say = (line: string) => onLog?.(`App checks: ${line}`);
  // The same commit, base, commands and settings give the same answer: it is not asked twice
  const memory: CheckMemory | undefined = options.memory ? openCheckMemory(options.memory, options.lockDir) : undefined;
  // The saved preview services decide what the start-up check starts: they are part of what a result was got with
  const settings = [options.commands ?? null, Object.entries(options.env).sort(([a], [b]) => a.localeCompare(b)), options.previewServices ?? null];
  const reportKey = memoryKey([commit, baseCommit, settings]);
  const kept = options.fresh ? undefined : memory?.report(reportKey);
  if (kept) {
    say(`commit ${commit.slice(0, 7)} was already checked ${ago(kept.at)}, with the same commands and settings: not running them again`);
    return { ...kept.report, fromRunAt: kept.at };
  }

  const docker = options.docker ?? hostDocker(hostEnv, signal);
  // The compose file's host ports, decided once for the run and the same for both copies: on them when
  // all are free (an address the project hard-codes then reaches its service), on free ports otherwise
  const wantedPorts = [...new Set(from.compose.filter((service) => !adapterOf(service.kind).fixedHostPort).flatMap((service) => service.ports.map((port) => port.host)))]
    .filter((port): port is number => port !== undefined && port >= 1024);
  const portFree = options.hostPortFree ?? localPortFree;
  let takenPort: number | undefined;
  for (const port of wantedPorts) {
    if (!(await portFree(port))) {
      takenPort = port;
      break;
    }
  }
  const ownPorts = wantedPorts.length > 0 && takenPort === undefined;
  /** Why starting the project can't tell anything this run: a port it may need is someone else's */
  const startsCannot = takenPort === undefined ? undefined : `Port ${takenPort} is in use on this computer (an open preview of this project, or something else), so the project could not be started on the ports it expects.`;
  /** A copy had to put a compose service on another port than the other copy: comparing the two says nothing */
  let portsMoved = false;
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
    const result = await runShell(command, {
      cwd, env, timeoutMs, signal, killGroup: true, killGraceMs: options.killGraceMs, maxOutput: 1024,
      // Line by line, before the cut: a cut through a value would leave a part no match can find.
      // Best effort, not a boundary: code that means to leak a value can encode it.
      onLine: (line) => { tail = `${tail}${redact(line)}\n`.slice(-TAIL_CHARS); },
    });
    const outcome: CheckOutcome = result.timedOut ? 'timed_out' : result.code === 0 ? 'passed' : result.code === 127 || result.code === 126 ? 'unavailable' : 'failed';
    return { outcome, exitCode: result.code, tail };
  };
  /** Whether the last copy had to do without a database or service it needs: its failures may be only that */
  let copyWithoutServices = false;
  /** Why, in the copy's own words */
  let copyServicesReason = '';
  /** A clean copy of a commit, gone afterwards */
  const inCopy = async <T>(at: string, work: (cwd: string, services: { started: StartedService[]; compose: ComposeWiring }) => Promise<T>): Promise<T> => {
    const parent = mkdtempSync(join(tmpdir(), 'vibe-teamlead-verify-'));
    const cwd = join(parent, 'copy');
    say(`a clean copy of ${at.slice(0, 7)}`);
    try {
      const cloned = await run(['clone', '-q', '--no-hardlinks', '--no-checkout', worktreePath, cwd]);
      if (!cloned.ok) throw new Error(cloned.output || 'git clone failed');
      const checkedOut = await run(['checkout', '-q', '--detach', at], cwd);
      if (!checkedOut.ok) throw new Error(checkedOut.output || 'git checkout failed');
      // One network for the copy's containers: they reach each other by their compose names
      const network = from.images.length || from.compose.length ? await createRunNetwork(docker, VERIFY_LABEL, serviceLabel) : undefined;
      if (from.images.length) say(`starting ${from.images.map((image) => image.image).join(', ')} for this copy`);
      const started = await startTestServices(from.images, { docker, label: serviceLabel, network: network?.name });
      if (started.status === 'started') say('database up');
      else if (started.status === 'unavailable') say(`no database: ${started.reason ?? 'it could not start'}`);
      // The compose file's other services (queues, storage, search…), after the database: its start clears the label's leftovers
      const composeNames = from.compose.map((service) => service.name).join(', ');
      if (from.compose.length) say(`starting ${composeNames} for this copy`);
      const compose = await startComposeServices(from.compose, {
        docker, labelKey: VERIFY_LABEL, labelValue: serviceLabel, network: network?.name, buckets: bucketsOf(from.example), signal,
        ...(ownPorts ? { hostPortFree: async (port: number) => wantedPorts.includes(port) } : {}),
      });
      for (const moved of compose.moved) {
        portsMoved = true;
        say(`${moved.name} had to move to another port (${moved.got}, not ${moved.wanted}): failures here are not compared with the other copy`);
      }
      if (compose.started.length) say(`${compose.started.map((service) => service.name).join(', ')} up`);
      for (const failure of compose.failed) say(`${failure.name}: ${failure.reason}`);
      if (compose.status === 'unavailable' && compose.reason && !compose.failed.length) say(`no ${composeNames}: ${compose.reason}`);
      try {
        const statuses = [started.status, compose.status].filter((status) => status !== 'none');
        copyWithoutServices = statuses.includes('unavailable');
        const reason = [started.reason, compose.status === 'unavailable' ? compose.reason : undefined].filter(Boolean).join(' ');
        copyServicesReason = copyWithoutServices ? reason : '';
        if (statuses.length) {
          services ??= {
            status: statuses.includes('unavailable') ? 'unavailable' : 'started',
            images: [...from.images.map((image) => image.image), ...from.compose.map((service) => service.image)],
            ...(reason ? { reason } : {}),
          };
        }
        const variables = { ...serviceEnv(from.example, started.started, { planned: from.compose, started: compose.started }), ...options.env };
        env = verificationEnv(hostEnv, variables);
        // Set by the project's settings, an address may be anything, so migrations stay away from it
        const ownDatabase = Object.keys(options.env).some((name) => /(DATABASE|POSTGRES|MYSQL|MONGO|^DB|^PG)/i.test(name));
        // The migration tools here are for SQL databases
        migratable = !ownDatabase && !from.committedDatabase && started.started.some((service) => service.kind === 'postgres' || service.kind === 'mysql');
        // Example values aren't secrets, the project's own values and the database addresses are
        secrets = [...Object.values(options.env), ...started.started.flatMap((service) => [service.url, new URL(service.url).password]), ...composeSecrets(compose.started)];
        return await work(cwd, { started: started.started, compose: { planned: from.compose, started: compose.started } });
      } finally {
        await compose.stop();
        await started.stop();
        await network?.remove();
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
      say(`installing: ${command}`);
      const startedAt = Date.now();
      let result = await shell(command, cwd, installTimeout);
      // A stall says more about the machine than the task: asleep, or busy with other tasks
      if (result.outcome === 'timed_out') result = await shell(command, cwd, installTimeout);
      say(`${command} ${result.outcome.replace('_', ' ')} in ${took(Date.now() - startedAt)}`);
      if (result.outcome !== 'passed') return { name: 'install', command, ...result };
    }
    if (!migratable) {
      if (detected.prepare?.length) migrationsSkipped = true;
      return undefined;
    }
    for (const command of detected.prepare ?? []) {
      say(`migrations: ${command}`);
      const result = await shell(command, cwd, installTimeout);
      if (result.outcome !== 'passed') return { name: 'prepare', command, ...result };
    }
    return undefined;
  };

  const startsCheck = options.startsCheck ?? realStartsCheck;
  /**
   * The names of the services a commit starts, by its recipe: read from git, without a copy, and
   * without blocking (this runs in the main process after a merge). A folder that is a link in the
   * commit counts as leading out, as it does in a copy. Empty when it starts nothing with one page.
   */
  const servicesAt = async (at: string): Promise<string[]> => {
    const listed = (await run(['ls-tree', '-r', '-z', at])).raw.split('\0').filter(Boolean);
    const atFiles: string[] = [];
    const links: string[] = [];
    for (const entry of listed) {
      const tab = entry.indexOf('\t');
      const path = entry.slice(tab + 1);
      atFiles.push(path);
      if (entry.startsWith('120000 ')) links.push(path);
    }
    const contents = await readAt(git, worktreePath, withoutGitHooks(hostEnv), at, atFiles.filter((file) => RECIPE_INPUT.test(file)).slice(0, MAX_RECIPE_INPUTS));
    const { recipe } = resolveRecipe({
      files: atFiles,
      read: (file) => contents.get(file) ?? null,
      saved: options.previewServices ?? [],
      contained: (dir) => !links.some((link) => dir === link || dir.startsWith(`${link}/`)),
    });
    const services = recipe.kind === 'web' ? (recipe.services ?? []) : [];
    return services.filter((service) => service.page).length === 1 ? services.map((service) => service.name) : [];
  };
  /** This run's own servers: another project's run may be starting its project at the same time */
  const runId = randomBytes(4).toString('hex');
  /** The project started in this copy, by its recipe; once more when it failed only for a port in use */
  const starts = async (cwd: string, at: string, services: { started: StartedService[]; compose: ComposeWiring }): Promise<CheckResult | null> => {
    const files = (await run(['ls-tree', '-r', '-z', '--name-only', at])).raw.split('\0').filter(Boolean);
    const read = (file: string) => {
      try {
        return readFileSync(join(cwd, file), 'utf-8');
      } catch {
        return null;
      }
    };
    // On the task's copy: what the base starts, so a service that is no longer found is noticed
    const expectServices = at === commit && at !== baseCommit ? await servicesAt(baseCommit).catch(() => []) : undefined;
    // A copy without the database or services its project needs proves nothing about its start
    const cannot = startsCannot ?? (copyWithoutServices ? `The copy ran without the database or services the project needs: ${copyServicesReason || "Docker isn't running"}.` : undefined);
    const once = () => startsCheck({
      cwd, files, read, runId, ...(expectServices ? { expectServices } : {}), saved: options.previewServices ?? [], started: services.started, compose: services.compose,
      ...(cannot ? { cannot, cannotWhy: startsCannot && takenPort !== undefined ? { reason: 'port', ports: [takenPort] } : { reason: 'services' } } : {}),
      // The recipe's migrations and seed, by the rule the detected ones follow: only the copy's own throwaway database
      migratable,
      ...(at === commit && options.onAppUp ? { onUp: options.onAppUp } : {}),
      timeoutMs: checkTimeout,
      runCommand: async (command, dir, variables) => {
        let output = '';
        const result = await runShell(command, {
          cwd: dir, env: verificationEnv(hostEnv, { ...variables, ...options.env }), timeoutMs: checkTimeout, signal, killGroup: true, killGraceMs: options.killGraceMs, maxOutput: 1024,
          // The end, where the error is, and line by line through the redaction, as for the other checks
          onLine: (line) => { output = `${output}${redact(line)}\n`.slice(-TAIL_CHARS); },
        });
        return { code: result.code, output, timedOut: result.timedOut };
      },
      deps: startsDeps(hostEnv, options.env),
      signal,
    });
    say('starting the project by its recipe');
    const startedAt = Date.now();
    let result = await once();
    if (!result) {
      say('nothing to start: no recipe or single page');
      return null;
    }
    let flaky = false;
    if (result.outcome === 'failed' && PORT_IN_USE.test(result.tail ?? '')) {
      const again = await once();
      if (again?.outcome === 'passed') {
        result = again;
        flaky = true;
      }
    }
    say(`the project ${STARTS_WORDS[result.outcome]} in ${took(Date.now() - startedAt)}`);
    return { ...STARTS_CHECK, outcome: result.outcome, ...(result.why ? { why: result.why } : {}), ...(result.tail ? { tail: redact(result.tail) } : {}), ...(flaky ? { flaky } : {}) };
  };

  const results = await inCopy(commit, async (cwd, services) => {
    const failedInstall = await install(cwd);
    if (failedInstall) return [failedInstall];
    const done: CheckResult[] = [];
    for (const check of checks) {
      say(`running ${check.command}`);
      const startedAt = Date.now();
      let result = await shell(check.command, cwd, checkTimeout);
      let flaky = false;
      if (result.outcome === 'failed' || result.outcome === 'timed_out') {
        const again = await shell(check.command, cwd, checkTimeout);
        if (again.outcome === 'passed') {
          flaky = true;
          result = again;
        }
      }
      say(`${check.command} ${result.outcome.replace('_', ' ')} in ${took(Date.now() - startedAt)}${flaky ? ' (on the second try)' : ''}`);
      done.push({ ...check, ...result, ...(flaky ? { flaky } : {}) });
    }
    const started = await starts(cwd, commit, services);
    if (started) done.push(started);
    return done;
  });

  // Exit codes come from the task's code, so "tool missing" or a timeout proves nothing by itself: only the base can tell
  const failed = results.filter((result) => result.outcome !== 'passed');
  const baseTails = new Map<string, string>();
  const baseMemoryKey = (command: string) => memoryKey([baseCommit, command, settings]);
  // What an earlier run, of this task or another, found on this base commit
  if (memory && !options.fresh && !source) {
    for (const result of failed) {
      const key = `${baseCommit}\0${result.command}`;
      const known = baseResults.has(key) ? undefined : memory.base(baseMemoryKey(result.command));
      if (!known) continue;
      baseResults.set(key, known.outcome);
      if (known.tail !== undefined) baseTails.set(key, known.tail);
    }
  }
  // With the task's own commands there is nothing on the base to compare with
  // A start not judged on the task blocks nothing whatever the base says: no copy of the base for it
  const unknown = source ? [] : failed.filter((result) => !baseResults.has(`${baseCommit}\0${result.command}`) && !(result.name === STARTS_CHECK.name && result.outcome === 'unavailable'));
  if (unknown.length) {
    for (const result of unknown) say(`${result.command} ${result.outcome.replace('_', ' ')}: running it on ${baseRef} to see whether the task broke it`);
    await inCopy(baseCommit, async (cwd, services) => {
      const failedInstall = await install(cwd);
      for (const result of unknown) {
        const key = `${baseCommit}\0${result.command}`;
        if (result.name === 'install' || result.name === 'prepare') baseResults.set(key, failedInstall?.command === result.command ? failedInstall.outcome : 'passed');
        else if (result.name === STARTS_CHECK.name && !failedInstall) {
          // The base started by its own recipe: a base with nothing to start can't be compared with
          const onBase = await starts(cwd, baseCommit, services);
          baseResults.set(key, onBase?.outcome ?? 'unavailable');
          if (onBase?.tail) baseTails.set(key, onBase.tail);
          say(`on ${baseRef}, the project ${onBase?.outcome === 'passed' ? 'started: the task broke its start' : `${(onBase?.outcome ?? 'unavailable').replace('_', ' ')} too: it says nothing about the task`}`);
        }
        else if (failedInstall) {
          baseResults.set(key, failedInstall.outcome);
          baseTails.set(key, failedInstall.tail ?? '');
        } else {
          let onBase = await shell(result.command, cwd, checkTimeout);
          // As on the task: a flaky test here would hide what the task broke
          if (onBase.outcome === 'failed') onBase = await shell(result.command, cwd, checkTimeout);
          baseResults.set(key, onBase.outcome);
          baseTails.set(key, onBase.tail ?? '');
          say(`on ${baseRef}, ${result.command} ${onBase.outcome === 'passed' ? 'passed: the task broke it' : `${onBase.outcome.replace('_', ' ')} too: it says nothing about the task`}`);
        }
      }
    });
    // Kept only when it is an answer: not a run out of time, a missing tool or a missing database
    if (memory && !copyWithoutServices && !portsMoved) {
      for (const result of unknown) {
        const key = `${baseCommit}\0${result.command}`;
        const outcome = baseResults.get(key);
        if (outcome === 'passed' || outcome === 'failed') memory.keepBase(baseMemoryKey(result.command), { outcome, ...(baseTails.has(key) ? { tail: baseTails.get(key) } : {}) });
      }
    }
  }
  for (const result of failed) {
    const key = `${baseCommit}\0${result.command}`;
    result.onBase = baseResults.get(key);
    // A pass on a base that ran with other ports than the task proves nothing
    if (portsMoved && result.onBase === 'passed') result.onBase = 'unavailable';
    if (result.onBase !== 'passed' && baseTails.has(key)) result.tailOnBase = baseTails.get(key);
  }

  // A new project's first task is not blocked by its start alone: there is no base that started to compare with
  // Nothing ran at all (no checks, nothing to start): that is not a pass
  if (!results.length) return { status: tamper.length ? 'regression' : 'not_configured', commit, baseCommit, checks: [], tamper, runnerConfigChanged };
  const broke = failed.some(blocks(source));
  const status = broke || tamper.length ? 'regression' : results.every((result) => result.outcome === 'passed') ? 'passed' : 'not_verified';
  const report: VerificationReport = { status, commit, baseCommit, checks: results, tamper, runnerConfigChanged, ...(services ? { services } : {}), ...(migrationsSkipped ? { migrationsSkipped } : {}), ...(source ? { source } : {}) };
  if (memory && isAnAnswer(report) && !portsMoved) memory.keepReport(reportKey, report);
  return report;
}

/**
 * Whether a check that did not pass blocks the task. On a new project's first task its own checks
 * do (there is no base), but not its start alone. Otherwise when it passes on the base, except a
 * start the check could not judge on the task (a service no longer found, a port in use): it may be
 * gone on purpose, and the reviewer is told instead. Pure.
 */
function blocks(source: VerificationReport['source']): (check: CheckResult) => boolean {
  return (check) => {
    const starts = check.name === STARTS_CHECK.name;
    if (source) return blocksOnItsOwn(check) && !starts;
    return check.onBase === 'passed' && !(starts && check.outcome === 'unavailable');
  };
}

/**
 * A check of the task's own that says the task is broken. A missing tool says nothing about it;
 * a failure or a timeout does, since no base exists to blame. Pure.
 */
function blocksOnItsOwn(check: CheckResult): boolean {
  return check.outcome === 'failed' || check.outcome === 'timed_out';
}

/**
 * A pass the reviewer may rely on without looking further. Not when the task changed
 * what decides how checks run, or part of it didn't run. Pure.
 */
export function verificationIsConclusive(report: VerificationReport): boolean {
  return report.status === 'passed' && !report.source && !report.runnerConfigChanged.length && !report.migrationsSkipped && report.services?.status !== 'unavailable';
}

/** What the task window shows. Pure. */
export function verificationSummary(report: VerificationReport): VerificationSummary {
  return {
    status: report.status,
    commit: report.commit,
    // Why the start could not be judged: the task window says it in the owner's language
    checks: report.checks.map(({ command, outcome, onBase, why }) => ({ command, outcome, ...(onBase ? { onBase } : {}), ...(why && outcome === 'unavailable' ? { why } : {}) })),
    ...(report.services ? { services: { status: report.services.status, images: report.services.images } } : {}),
    ...(report.migrationsSkipped ? { migrationsSkipped: true } : {}),
    ...(report.source ? { source: report.source } : {}),
  };
}

const OUTCOME_WORDS: Record<CheckOutcome, string> = { passed: 'passed', failed: 'FAILED', timed_out: 'ran out of time', unavailable: 'its tool is not installed' };

/** One line per check, for the task's log and for the QA reviewer: facts it need not check again. Pure. */
export function describeVerification(report: VerificationReport): string {
  const runner = report.runnerConfigChanged.length ? [`The task also changed files that decide how checks run, so look at these before trusting a pass: ${report.runnerConfigChanged.join(', ')}`] : [];
  if (report.status === 'not_configured' && !report.tamper.length) return ['The app found no checks to run for this project, so it verified nothing.', ...runner].join('\n');
  const lines = report.checks.map((check) => {
    const notJudged = check.name === STARTS_CHECK.name && check.outcome === 'unavailable';
    const base = check.onBase === undefined || notJudged ? '' : check.onBase === 'passed' ? ' (passes on the base: this task broke it)' : ' (the same on the base: says nothing about this task)';
    const starts = check.name === STARTS_CHECK.name;
    const what = starts ? 'The project starts' : check.command;
    // Not started for a reason outside the task (a port in use, Docker): the reason, not "a tool is missing"
    const outcome = starts && check.outcome === 'unavailable' ? `could not be judged${check.tail ? `: ${check.tail.split('\n')[0]}` : ''}` : OUTCOME_WORDS[check.outcome];
    return `- ${what}: ${outcome}${check.exitCode === undefined ? '' : ` (exit ${check.exitCode})`}${check.flaky ? ' (failed once, then passed: flaky)' : ''}${base}`;
  });
  if (report.migrationsSkipped) runner.push('The migrations were not run: there was no temporary database to run them on, and they could change a real one.');
  const databases = report.services?.status === 'started'
    ? [`Against temporary, empty services started for the checks: ${report.services.images.join(', ')}`]
    : report.services?.reason ? [report.services.reason] : [];
  const origin = report.source === 'task'
    ? ['The base branch has no checks yet, so these commands come from this task itself: a pass shows less than usual (the task chose what checks it), a failure is the task\'s own.']
    : [];
  const earlier = report.fromRunAt
    ? [`These are the results of its run at ${report.fromRunAt}: the commit, its base, the commands and the settings are the same, so it did not run them again.`]
    : [];
  return [`The app ran these itself on a clean copy of commit ${report.commit.slice(0, 8)}:`, ...earlier, ...origin, ...databases, ...lines, ...report.tamper.map((finding) => `- ${finding.file}: ${finding.detail}`), ...runner].join('\n');
}

/** The start-up check as QA reads it when the task broke the project's start */
function startsIssue(check: CheckResult) {
  const summary = failureSummary(check.tail ?? '');
  return {
    key: `check:${check.command}`,
    type: 'critical' as const,
    title: 'The project no longer starts: it starts on the commit this task started from',
    description: `The app started the project by its recipe (preview.json, or what it works out from the files) on a clean copy, as the Preview does, and it did not come up.${summary ? `\n\nWhat failed:\n${summary}\n` : ''}\nThe end of the output:\n${check.tail ?? ''}`,
    fix_required: 'Make the project start again. If how it is installed, configured or started changed on purpose, update preview.json (and RUNNING.md) to match. Commit it: the app checks what is committed, on a clean copy.',
  };
}

/** What must be fixed before a review can pass. Keys ignore the wording, to compare rounds. Pure. */
/** Lines that say what failed, in the output of test runners, builds and package managers */
const FAILURE_LINE = /(^|\s)(Error|ERROR|error TS\d+|FAIL|FAILED|AssertionError|TypeError|ReferenceError|SyntaxError|ERR!|\u2717|\u00d7|\u2a2f)\b|(^|\s)(\u00d7|\u2a2f|\u2717)\s|\bfailed\b|Cannot find|at <unknown> \(|^\s+at .*\.(t|j)sx?:\d+/;
const PASSING_LINE = /\bpassed\b|\u2713/;
const SUMMARY_LINES = 15;
const SUMMARY_CHARS = 1500;

/**
 * The part of a failing check's output that says what failed: the workspace
 * package a recursive run stopped in, and the error lines. The end of the output
 * alone can be mostly passing tests of another package, and a fixer went after
 * those instead. Empty when nothing looks like a failure. Pure.
 */
export function failureSummary(tail: string): string {
  // pnpm draws its error in a box and wraps the path across lines
  const unboxed = tail.replace(/\n\s*\u2502\s?/g, '');
  const where = /recursive run" failed in \S*?\/copy\/(\S+?)\/?(\s|$)/.exec(unboxed)?.[1];
  const lines: string[] = [];
  for (const raw of tail.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || PASSING_LINE.test(line) || /^\s*\u2502/.test(line) || !FAILURE_LINE.test(line)) continue;
    if (!lines.includes(line)) lines.push(line.slice(0, 300));
    if (lines.length >= SUMMARY_LINES) break;
  }
  if (!where && !lines.length) return '';
  return [where ? `Failed in ${where}.` : '', ...lines].filter(Boolean).join('\n').slice(0, SUMMARY_CHARS);
}

export function verificationIssues(report: VerificationReport): { key: string; type: 'critical'; title: string; description: string; location?: string; fix_required: string }[] {
  return [
    ...report.checks.filter((check) => check.outcome !== 'passed' && blocks(report.source)(check)).map((check) => check.name === STARTS_CHECK.name ? startsIssue(check) : ({
      key: `check:${check.command}`,
      type: 'critical' as const,
      title: report.source
        ? `\`${check.command}\` ${check.outcome === 'timed_out' ? 'runs out of time' : 'fails'} on this task (its own check: the base has none yet)`
        : `\`${check.command}\` ${check.outcome === 'timed_out' ? 'runs out of time' : 'fails'} on this task and passes on the commit it started from`,
      description: (() => {
        const summary = failureSummary(check.tail ?? '');
        return `Exit code ${check.exitCode}.${summary ? `\n\nWhat failed:\n${summary}\n` : ''}\nThe end of its output:\n${check.tail ?? ''}`;
      })(),
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
