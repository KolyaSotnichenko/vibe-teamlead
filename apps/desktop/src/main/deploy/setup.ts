/**
 * Deploy setup for a project: accounts → GitHub repository (+ push) → Vercel project → enabled.
 *
 * Every step records its result in `settings.deploy` (through `saveSettings`) before the
 * next one starts, so a re-run after a crash at any point picks up where it stopped and
 * creates nothing twice:
 * - a repo the app created is recorded before the origin is added and the branch pushed
 *   (adding the origin and pushing are themselves repeatable);
 * - a Vercel project created but not yet recorded is found again by name and adopted when
 *   it is linked to the same repository.
 * The one window left is between GitHub answering "created" and the settings write; a crash
 * exactly there leaves an unrecorded empty repo and the re-run creates `<name>-2`.
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
  VercelStatus,
} from '../../shared/types/deploy';
import type { GitHubAppAccess } from '../../shared/types/integrations';
import { GITHUB_APP_INSTALL_URL } from '../../shared/constants/github';
import { GitHubWriteError } from './github-write';
import { isVercelError, type VercelClient } from './vercel-api';

type Repo = { owner: string; repo: string };

/** What setup needs to know about the project's git repository, read from files only. */
export interface GitInfo {
  originUrl?: string;
  /** Local branch names. */
  branches: string[];
  /** The checked-out branch, when HEAD is on one. */
  head?: string;
}

export interface SetupDeps {
  vercelStatus: () => Promise<VercelStatus>;
  /** A Vercel client for a scope (`{}` = personal account). */
  vercelClient: (scope: { teamId?: string }) => VercelClient;
  isGitHubSignedIn: () => Promise<boolean>;
  /** `getGitHubAppAccess` (github-auth/app-access.ts). */
  appAccess: (repo?: Repo) => Promise<GitHubAppAccess | { error: string }>;
  /** null when the project is not a git repository. */
  readGit: (projectPath: string) => Promise<GitInfo | null>;
  createPrivateRepo: (name: string) => Promise<{ owner: string; repo: string; cloneUrl: string }>;
  repoVisibility: (owner: string, repo: string) => Promise<'private' | 'public'>;
  addOriginIfMissing: (projectPath: string, cloneUrl: string) => Promise<boolean>;
  pushWithAppToken: (projectPath: string, url: string, refspec: string) => Promise<void>;
  /** Persists `project.settings.deploy`. */
  saveSettings: (deploy: DeployProjectSettings) => Promise<void> | void;
  onProgress?: (step: DeploySetupStep) => void;
  now?: () => Date;
  /** The Vercel team the owner picked; personal scope when absent. A team already recorded for the project wins. */
  vercelTeamId?: string;
}

const MAX_PROJECT_NAME_TRIES = 5;
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

/** Vercel project names: lowercase, letters, digits, '.', '_', '-', no '---', at most 100. */
function vercelNameFor(repo: string): string {
  const name = repo
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{3,}/g, '--')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 100);
  return name || 'project';
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
  if (isVercelError(e)) return { kind: e.kind, message: e.message };
  // Unknown errors may carry anything (paths, command output): never shown.
  return { kind: 'unknown', message: 'Setup stopped unexpectedly. Try again.' };
}

class Stop {
  constructor(readonly error?: DeploySetupError) {}
}

export async function setUpDeploy(project: Project, deps: SetupDeps): Promise<DeploySetupState> {
  let settings: DeployProjectSettings = { enabled: false, ...structuredClone(project.settings.deploy ?? {}) };
  const needed: NeededFromYou[] = [];
  let step: DeploySetupStep | undefined;
  const now = deps.now ?? (() => new Date());

  /** Saves `settings` with `patch` applied; the in-memory state changes only once the save succeeded. */
  const record = async (patch: Partial<DeployProjectSettings>) => {
    const next = { ...settings, ...patch };
    await deps.saveSettings(structuredClone(next));
    settings = next;
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

  try {
    // 1. Accounts.
    const status = await deps.vercelStatus();
    if (!status.connected) {
      if (status.error) throw new Stop({ kind: 'unavailable', message: 'Could not reach Vercel. Try again.' });
      need({ id: 'vercel-sign-in', kind: 'vercel-sign-in', message: 'Sign in to Vercel in Settings → Vercel.' });
    }
    if (!(await deps.isGitHubSignedIn())) {
      need({ id: 'github-sign-in', kind: 'github-sign-in', message: 'Sign in to GitHub in Settings → GitHub.' });
    }

    // 2. Repository.
    enter('repo');
    let repo = settings.repo;
    if (!repo) {
      const info = await readGit();
      if (info.originUrl) {
        const gh =
          classifyRemote(info.originUrl) ??
          need({
            id: 'non-github-remote',
            kind: 'non-github-remote',
            message: "The project's origin is not on GitHub. Deploy works with GitHub repositories only.",
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
        await checkAccess();
        const created = await deps.createPrivateRepo(repoNameFor(project.path));
        repo = { owner: created.owner, repo: created.repo, createdByApp: true, public: false };
        await record({ repo });
        await checkAccess(repo);
      }
    } else {
      await checkAccess(repo);
    }

    // Push: only into a repo the app created, until the Vercel project exists (it builds from it).
    if (repo.createdByApp && !settings.vercel) {
      enter('push');
      const url = githubUrl(repo);
      const info = await readGit();
      await deps.addOriginIfMissing(project.path, url);
      await deps.pushWithAppToken(project.path, url, mainBranchFor(project, info));
    }

    // 3. Vercel project.
    enter('vercel');
    const teamId = settings.vercel?.teamId ?? deps.vercelTeamId;
    const client = deps.vercelClient(teamId ? { teamId } : {});
    const fullRepo = `${repo.owner}/${repo.repo}`;
    const recorded = settings.vercel ? await client.findProject(settings.vercel.projectId) : null;
    if (!recorded) {
      const base = vercelNameFor(repo.repo);
      let found: { id: string; name: string } | null = null;
      for (let attempt = 1; attempt <= MAX_PROJECT_NAME_TRIES && !found; attempt++) {
        const name = attempt === 1 ? base : `${base.slice(0, 97)}-${attempt}`;
        const existing = await client.findProject(name);
        if (existing) {
          // Ours from a run that stopped before recording it; otherwise the name is taken.
          if (existing.link?.repo?.toLowerCase() === fullRepo.toLowerCase()) found = existing;
          continue;
        }
        try {
          found = await client.createProject({ name, repo: fullRepo });
        } catch (e) {
          if (isVercelError(e) && e.kind === 'conflict') continue;
          if (isVercelError(e) && e.kind === 'git-not-connected') {
            need({
              id: 'vercel-git-access',
              kind: 'vercel-git-access',
              message: `Let Vercel's GitHub App access ${fullRepo}, then try again.`,
              ...(e.actionUrl ? { actionUrl: e.actionUrl } : {}),
            });
          }
          throw e;
        }
      }
      if (!found) throw new Stop({ kind: 'conflict', message: `Vercel project names for ${repo.repo} are all taken.` });
      await record({ vercel: { projectId: found.id, projectName: found.name, ...(teamId ? { teamId } : {}) } });
    }

    // 4. Enabled.
    await record({ enabled: true, setUpAt: settings.setUpAt ?? now().toISOString() });
    enter('done');
    return { settings: structuredClone(settings), needed, step };
  } catch (e) {
    const error = e instanceof Stop ? e.error : toError(e);
    return { settings: structuredClone(settings), needed, ...(step ? { step } : {}), ...(error ? { error } : {}) };
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

/** First `url` of `[remote "origin"]` in a git config text. `include`s are not followed. */
function originFromConfig(text: string): string | undefined {
  let inOrigin = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin';
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!kv || kv[1].toLowerCase() !== 'url') continue;
    let value = kv[2];
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      value = value.replace(/\s[#;].*$/, '');
    }
    value = value.trim();
    if (value) return value;
  }
  return undefined;
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

  const config = (await readSmall(path.join(commonDir, 'config'))) ?? '';
  const branches: string[] = [];
  await looseBranches(path.join(commonDir, 'refs', 'heads'), '', branches);
  const packed = (await readSmall(path.join(commonDir, 'packed-refs'), PACKED_MAX)) ?? '';
  for (const line of packed.split('\n')) {
    const m = /^[0-9a-f]{40,64} refs\/heads\/(\S+)$/.exec(line.trim());
    if (m && !branches.includes(m[1])) branches.push(m[1]);
  }
  const head = /^ref:\s*refs\/heads\/(\S+)\s*$/.exec(headText.trim())?.[1];
  const originUrl = originFromConfig(config);
  return { branches, ...(head ? { head } : {}), ...(originUrl ? { originUrl } : {}) };
}

/** Production wiring: the real GitHub/Vercel functions and the project store. Imported lazily (Electron). */
export async function createSetupDeps(
  project: Project,
  extra: Pick<SetupDeps, 'onProgress' | 'vercelTeamId'> = {},
): Promise<SetupDeps> {
  const [credential, vercelApi, githubWrite, appAccess, tokenStore, store] = await Promise.all([
    import('./vercel-credential'),
    import('./vercel-api'),
    import('./github-write'),
    import('../github-auth/app-access'),
    import('../github-auth/token-store'),
    import('../project-store'),
  ]);
  return {
    vercelStatus: () => credential.vercelStatus(),
    vercelClient: (scope) => vercelApi.createVercelClient(vercelApi.defaultVercelFetcher, scope, () => credential.getVercelToken()),
    isGitHubSignedIn: async () => !!(await tokenStore.getValidAccessToken()),
    appAccess: (repo) => appAccess.getGitHubAppAccess(repo),
    readGit: readGitInfo,
    createPrivateRepo: (name) => githubWrite.createPrivateRepo(name),
    repoVisibility: (owner, repo) => githubWrite.repoVisibility(owner, repo),
    addOriginIfMissing: (p, url) => githubWrite.addOriginIfMissing(p, url),
    pushWithAppToken: (p, url, refspec) => githubWrite.pushWithAppToken(p, url, refspec),
    saveSettings: (deploy) => {
      store.projectStore.updateProjectSettings(project.id, { deploy });
    },
    ...extra,
  };
}
