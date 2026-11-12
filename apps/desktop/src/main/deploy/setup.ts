/**
 * CI setup for a project: GitHub account → GitHub repository (adopted or created, + push of main
 * into a repository the app created) → enabled. Set up means the repository step is done
 * (`isCiSetUp`, ci-setup.ts); `enabled` and `setUpAt` are recorded once it is.
 *
 * Every step records its result in `settings.deploy` (through `saveSettings`) before the
 * next one starts, so a re-run after a crash at any point picks up where it stopped and
 * creates nothing twice:
 * - before asking GitHub for a repo, `pendingRepo` {base, owner, at} is recorded; a re-run
 *   adopts a repo of that owner named base[-2..5] only if it is private, has no branches and
 *   was created after `at` (minus 2 min skew), and never an older one;
 * - the created repo is recorded before the origin is added and the branch pushed (both repeatable).
 *
 * Fields old data may still carry (the Vercel project, database, services) are kept and ignored.
 *
 * `setUpDeploy` never throws: what the owner must do becomes `needed`, failures become
 * `error` (a kind + a message without secrets). All dependencies are injected.
 */
import type { Dirent } from 'fs';
import { lstat, open, readdir } from 'fs/promises';
import path from 'path';
import type { Project } from '../../shared/types';
import type {
  DeployProjectSettings,
  DeploySetupError,
  DeploySetupState,
  DeploySetupStep,
  NeededFromYou,
} from '../../shared/types/deploy';
import type { GitHubAppAccess } from '../../shared/types/integrations';
import { GITHUB_APP_INSTALL_URL } from '../../shared/constants/github';
import { GitHubWriteError } from './github-write';

type Repo = { owner: string; repo: string };

/** What setup needs to know about the project's git repository, read from files only. */
export interface GitInfo {
  originUrl?: string;
  /** The config has include/includeIf: origin could be set or changed elsewhere. */
  originUnclear?: boolean;
  /** Origin has a pushurl, or a url.*.insteadOf / pushInsteadOf rule exists: pushes may go elsewhere. */
  originRewritten?: boolean;
  /** Local branch names. */
  branches: string[];
  /** The checked-out branch, when HEAD is on one. */
  head?: string;
}

export interface SetupDeps {
  isGitHubSignedIn: () => Promise<boolean>;
  /** Login of the GitHub user the App token acts for (GET /user). */
  githubLogin: () => Promise<string>;
  /** `getGitHubAppAccess` (github-auth/app-access.ts). */
  appAccess: (repo?: Repo) => Promise<GitHubAppAccess | { error: string }>;
  /** null when the project is not a git repository. */
  readGit: (projectPath: string) => Promise<GitInfo | null>;
  createPrivateRepo: (name: string) => Promise<{ owner: string; repo: string; cloneUrl: string }>;
  /** null when the repo doesn't exist. `empty`: GitHub answered with no branches. */
  inspectRepo: (owner: string, repo: string) => Promise<{ private: boolean; createdAt: string; empty: boolean } | null>;
  repoVisibility: (owner: string, repo: string) => Promise<'private' | 'public'>;
  addOriginIfMissing: (projectPath: string, cloneUrl: string) => Promise<boolean>;
  pushWithAppToken: (projectPath: string, url: string, refspec: string) => Promise<void>;
  /** Merges `patch` into the stored `project.settings.deploy` (an undefined value clears that field). Throws when it can't save. */
  saveSettings: (patch: Partial<DeployProjectSettings>) => Promise<void> | void;
  onProgress?: (step: DeploySetupStep) => void;
  now?: () => Date;
}

const NAME_PART = '[A-Za-z0-9_.-]+';
const HTTPS_REMOTE = new RegExp(`^https?://(?:[^@/\\s]+@)?github\\.com(?::443)?/(${NAME_PART})/(${NAME_PART}?)(?:\\.git)?/?$`, 'i');
const SSH_REMOTE = new RegExp(`^ssh://(?:[^@/\\s]+@)?github\\.com(?::\\d+)?/(${NAME_PART})/(${NAME_PART}?)(?:\\.git)?/?$`, 'i');
const SCP_REMOTE = new RegExp(`^(?:[\\w.-]+@)?github\\.com:(${NAME_PART})/(${NAME_PART}?)(?:\\.git)?/?$`, 'i');

/** GitHub https/ssh remote → owner/repo; anything else → null. */
export function classifyRemote(url: string): Repo | null {
  const trimmed = url.trim();
  for (const re of [HTTPS_REMOTE, SSH_REMOTE, SCP_REMOTE]) {
    const m = re.exec(trimmed);
    if (m) {
      const [, owner, repo] = m;
      if (!repo || [owner, repo].some((s) => s === '.' || s === '..')) return null;
      return { owner, repo };
    }
  }
  return null;
}

const githubUrl = (r: Repo) => `https://github.com/${r.owner}/${r.repo}.git`;

/** GitHub turns other characters into '-' itself; done here so the name we ask for is the name we get. */
function repoNameFor(projectPath: string): string {
  const base = path.basename(path.resolve(projectPath)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  return base || 'project';
}

const BRANCH_OK = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

function mainBranchFor(project: Project, git: GitInfo): string {
  const configured = project.settings.mainBranch?.trim();
  if (configured && BRANCH_OK.test(configured)) return configured;
  for (const b of ['main', 'master']) if (git.branches.includes(b)) return b;
  return git.head ?? 'main';
}

function toError(e: unknown): DeploySetupError {
  if (e instanceof GitHubWriteError) return { kind: e.kind, message: e.message };
  // Unknown errors may carry anything (paths, command output): never shown.
  return { kind: 'unknown', message: 'Setup stopped unexpectedly. Try again.' };
}

class Stop {
  constructor(readonly error?: DeploySetupError) {}
}

/** A resource the app asked to create counts as ours if it appeared at most this long before the request was recorded. */
const ADOPT_SKEW_MS = 2 * 60 * 1000;

/** Drops keys whose value is undefined (cleared fields). */
function clean(settings: DeployProjectSettings): DeployProjectSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) as unknown as DeployProjectSettings;
}

/** `name`, `name-2` … as createPrivateRepo tries them. */
function repoCandidates(base: string): string[] {
  return [base.slice(0, 100), ...[2, 3, 4, 5].map((n) => `${base.slice(0, 98)}-${n}`)];
}

export async function setUpDeploy(project: Project, deps: SetupDeps): Promise<DeploySetupState> {
  let settings: DeployProjectSettings = { enabled: false, ...structuredClone(project.settings.deploy ?? {}) };
  const needed: NeededFromYou[] = [];
  let step: DeploySetupStep | undefined;
  const now = deps.now ?? (() => new Date());

  /**
   * Saves `patch` (an undefined value clears that field); the in-memory state changes only once
   * the save succeeded. Only the patch is sent, so fields other writers set are kept.
   */
  const record = async (patch: Partial<DeployProjectSettings>) => {
    await deps.saveSettings(structuredClone(patch));
    settings = { ...settings, ...patch };
  };
  const enter = (s: DeploySetupStep) => {
    step = s;
    deps.onProgress?.(s);
  };
  const need = (item: NeededFromYou): never => {
    needed.push(item);
    throw new Stop();
  };
  const appInstallItem = (repo?: Repo): NeededFromYou => ({
    id: 'github-app-install',
    kind: 'github-app-install',
    message: repo
      ? `Give the Vibe Teamlead GitHub App access to ${repo.owner}/${repo.repo}, then try again.`
      : 'Install the Vibe Teamlead GitHub App on your GitHub account, then try again.',
    actionUrl: GITHUB_APP_INSTALL_URL,
  });
  const checkAccess = async (repo?: Repo) => {
    const access = await deps.appAccess(repo);
    if ('error' in access) throw new Stop({ kind: 'unavailable', message: access.error });
    if (!access.installed || (repo && !access.repoReachable)) need(appInstallItem(repo));
  };

  let git: GitInfo | null | undefined;
  const readGit = async (): Promise<GitInfo> => {
    if (git === undefined) git = await deps.readGit(project.path);
    if (!git) throw new Stop({ kind: 'invalid', message: 'The project folder is not a git repository.' });
    return git;
  };

  /** A repo from an earlier run that stopped between "create" and recording it: private, still empty, created after the request. */
  const recoverRepo = async (pending: NonNullable<DeployProjectSettings['pendingRepo']>): Promise<Repo | null> => {
    const since = Date.parse(pending.at) - ADOPT_SKEW_MS;
    for (const name of repoCandidates(pending.base)) {
      const info = await deps.inspectRepo(pending.owner, name);
      if (info?.private && info.empty && Date.parse(info.createdAt) >= since) return { owner: pending.owner, repo: name };
    }
    return null;
  };

  try {
    // 1. Account.
    if (!(await deps.isGitHubSignedIn())) {
      need({ id: 'github-sign-in', kind: 'github-sign-in', message: 'Sign in to GitHub in Settings → GitHub.' });
    }

    // 2. Repository.
    enter('repo');
    let repo = settings.repo;
    if (!repo) {
      const info = await readGit();
      if (info.originUnclear) {
        throw new Stop({
          kind: 'invalid',
          message: "The app can't tell where the project's origin points: its git config includes other files, or can't be read. Fix the config, then try again.",
        });
      }
      if (info.originUrl || info.originRewritten) {
        const gh =
          (info.originRewritten ? null : classifyRemote(info.originUrl ?? '')) ??
          need({
            id: 'non-github-remote',
            kind: 'non-github-remote',
            message: "The project's origin is not on GitHub. CI works with GitHub repositories only.",
          });
        await checkAccess(gh);
        const visibility = await deps.repoVisibility(gh.owner, gh.repo);
        repo = { owner: gh.owner, repo: gh.repo, createdByApp: false, public: visibility === 'public' };
        await record({ repo });
        if (repo.public) {
          needed.push({
            id: 'public-repo-warning',
            kind: 'public-repo-warning',
            message: `${repo.owner}/${repo.repo} is public: anyone can read its code.`,
            actionUrl: `https://github.com/${repo.owner}/${repo.repo}/settings`,
          });
        }
      } else {
        if (info.branches.length === 0) {
          throw new Stop({ kind: 'invalid', message: 'The project has no commits yet. Commit your code, then try again.' });
        }
        await checkAccess();
        let made = settings.pendingRepo ? await recoverRepo(settings.pendingRepo) : null;
        if (!made) {
          const base = repoNameFor(project.path);
          const owner = await deps.githubLogin();
          await record({ pendingRepo: { base, owner, at: now().toISOString() } });
          const created = await deps.createPrivateRepo(base);
          made = { owner: created.owner, repo: created.repo };
        }
        repo = { owner: made.owner, repo: made.repo, createdByApp: true, public: false };
        await record({ repo, pendingRepo: undefined });
        await checkAccess(repo);
      }
    } else {
      await checkAccess(repo);
    }

    // Push: only into a repo the app created, until setup has finished once (merges push main after that).
    if (repo.createdByApp && !settings.enabled) {
      enter('push');
      const url = githubUrl(repo);
      const info = await readGit();
      const branch = mainBranchFor(project, info);
      if (!info.branches.includes(branch)) {
        throw new Stop({
          kind: 'invalid',
          message:
            info.branches.length === 0
              ? 'The project has no commits yet. Commit your code, then try again.'
              : `The branch "${branch}" was not found in the project. Check the main branch in the project settings.`,
        });
      }
      await deps.addOriginIfMissing(project.path, url);
      await deps.pushWithAppToken(project.path, url, branch);
    }

    // 3. Enabled: the repository step is done.
    await record({ enabled: true, setUpAt: settings.setUpAt ?? now().toISOString() });
    enter('done');
    return { settings: clean(settings), needed, step };
  } catch (e) {
    const error = e instanceof Stop ? e.error : toError(e);
    return { settings: clean(settings), needed, ...(step ? { step } : {}), ...(error ? { error } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Reading the repository from files (no git process: the project's config can't run anything).

const SMALL = 64 * 1024;
const PACKED_MAX = 64 * 1024 * 1024;
const MAX_LOOSE_REFS = 5000;

async function readSmall(file: string, max = SMALL): Promise<string | null> {
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > max) return null;
    const handle = await open(file, 'r');
    try {
      return await handle.readFile('utf-8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * First `url` of `[remote "origin"]` in a git config text, plus what makes it untrustworthy:
 * include/includeIf (the origin could come from another file: not followed) and pushurl /
 * insteadOf / pushInsteadOf (pushes may go elsewhere).
 */
function originFromConfig(text: string): { url?: string; unclear?: true; rewritten?: true } {
  const out: { url?: string; unclear?: true; rewritten?: true } = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (header) {
      const name = header[1].toLowerCase();
      // `[remote "origin"]`, or the old `[remote.origin]` form.
      section = name === 'remote' && header[2] === 'origin' ? 'origin' : name === 'remote.origin' ? 'origin' : name;
      if (section === 'include' || section === 'includeif') out.unclear = true;
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (section === 'url' && (key === 'insteadof' || key === 'pushinsteadof')) out.rewritten = true;
    if (section !== 'origin') continue;
    if (key === 'pushurl') out.rewritten = true;
    if (key !== 'url' || out.url) continue;
    let value = kv[2] ?? '';
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      value = value.replace(/\s[#;].*$/, '');
    }
    value = value.trim();
    if (value) out.url = value;
  }
  return out;
}

async function looseBranches(dir: string, prefix: string, out: string[], depth = 0): Promise<void> {
  if (depth > 10 || out.length >= MAX_LOOSE_REFS) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) await looseBranches(path.join(dir, e.name), `${prefix}${e.name}/`, out, depth + 1);
    else if (e.isFile() && !e.name.endsWith('.lock')) out.push(`${prefix}${e.name}`);
  }
}

/** Origin URL, local branches and HEAD of the project, read from `.git` files. null when not a repository. */
export async function readGitInfo(projectPath: string): Promise<GitInfo | null> {
  const dotGit = path.join(projectPath, '.git');
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(dotGit);
  } catch {
    return null;
  }
  let gitDir = dotGit;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec((await readSmall(dotGit)) ?? '');
    if (!m) return null;
    gitDir = path.resolve(projectPath, m[1]);
  } else if (!st.isDirectory()) {
    return null;
  }
  const common = (await readSmall(path.join(gitDir, 'commondir')))?.trim();
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  const headText = await readSmall(path.join(gitDir, 'HEAD'));
  if (headText === null) return null;

  // A config that exists but can't be read in full (too large, not a regular file) hides where
  // origin points: that is "unclear", never "no origin" (setup would create a new repo).
  const configFile = path.join(commonDir, 'config');
  const configText = await readSmall(configFile);
  const configUnreadable = configText === null && (await lstat(configFile).then(() => true, () => false));
  const config = configText ?? '';
  const branches: string[] = [];
  await looseBranches(path.join(commonDir, 'refs', 'heads'), '', branches);
  const packed = (await readSmall(path.join(commonDir, 'packed-refs'), PACKED_MAX)) ?? '';
  for (const line of packed.split('\n')) {
    const m = /^[0-9a-f]{40,64} refs\/heads\/(\S+)$/.exec(line.trim());
    if (m && !branches.includes(m[1])) branches.push(m[1]);
  }
  const head = /^ref:\s*refs\/heads\/(\S+)\s*$/.exec(headText.trim())?.[1];
  const origin = originFromConfig(config);
  return {
    branches,
    ...(head ? { head } : {}),
    ...(origin.url ? { originUrl: origin.url } : {}),
    ...(origin.unclear || configUnreadable ? { originUnclear: true } : {}),
    ...(origin.rewritten ? { originRewritten: true } : {}),
  };
}

/** The part of the project store setup writes through. */
export interface DeploySettingsStore {
  getProject(projectId: string): Project | undefined;
  updateProjectSettings(projectId: string, settings: Partial<Project['settings']>): Project | undefined;
}

/**
 * Merges `patch` into the latest stored `deploy` (so fields other writers set meanwhile are kept;
 * an undefined value clears a field). Throws when the project is gone, so setup stops instead of
 * believing a step was recorded.
 */
export function saveDeployPatch(store: DeploySettingsStore, projectId: string, patch: Partial<DeployProjectSettings>): void {
  const current = store.getProject(projectId)?.settings.deploy;
  const merged = clean({ enabled: false, ...current, ...patch });
  if (!store.updateProjectSettings(projectId, { deploy: merged })) {
    throw new Error('The project could not be saved');
  }
}

/** Production wiring: the real GitHub functions and the project store. Imported lazily (Electron). */
export async function createSetupDeps(project: Project, extra: Pick<SetupDeps, 'onProgress'> = {}): Promise<SetupDeps> {
  const [githubWrite, appAccess, tokenStore, store] = await Promise.all([
    import('./github-write'),
    import('../github-auth/app-access'),
    import('../github-auth/token-store'),
    import('../project-store'),
  ]);
  return {
    isGitHubSignedIn: async () => !!(await tokenStore.getValidAccessToken()),
    appAccess: (repo) => appAccess.getGitHubAppAccess(repo),
    readGit: readGitInfo,
    createPrivateRepo: (name) => githubWrite.createPrivateRepo(name),
    repoVisibility: (owner, repo) => githubWrite.repoVisibility(owner, repo),
    addOriginIfMissing: (p, url) => githubWrite.addOriginIfMissing(p, url),
    pushWithAppToken: (p, url, refspec) => githubWrite.pushWithAppToken(p, url, refspec),
    githubLogin: () => githubWrite.getAuthenticatedLogin(),
    inspectRepo: (owner, repo) => githubWrite.inspectRepo(owner, repo),
    saveSettings: (patch) => saveDeployPatch(store.projectStore, project.id, patch),
    ...extra,
  };
}
