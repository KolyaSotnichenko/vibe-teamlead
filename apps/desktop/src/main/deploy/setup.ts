/**
 * Deploy setup for a project: accounts → GitHub repository (+ push) → Vercel project → enabled.
 *
 * Before the repository step, the project's commit author is set to an address GitHub ties to the
 * owner when git would otherwise sign as `user@machine.local` (commit-identity.ts).
 *
 * Every step records its result in `settings.deploy` (through `saveSettings`) before the
 * next one starts, so a re-run after a crash at any point picks up where it stopped and
 * creates nothing twice:
 * - before asking GitHub for a repo, `pendingRepo` {base, owner, at} is recorded; a re-run
 *   adopts a repo of that owner named base[-2..5] only if it is private, has no branches and
 *   was created after `at` (minus 2 min skew), and never an older one;
 * - the created repo is recorded before the origin is added and the branch pushed (both repeatable);
 * - before asking Vercel for a project, `pendingVercel` {name, at} is recorded; a re-run (or a
 *   409) adopts a project of that name only if linked to the same repo and created after `at`.
 *   A project already linked to the repo that the app didn't create stops setup with
 *   `vercel-existing-project`; the owner answers through `settings.deploy.vercelChoice`.
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
  vercelStatus: () => Promise<VercelStatus>;
  /** A Vercel client for a scope (`{}` = personal account). */
  vercelClient: (scope: { teamId?: string }) => VercelClient;
  isGitHubSignedIn: () => Promise<boolean>;
  /** Login of the GitHub user the App token acts for (GET /user). */
  githubLogin: () => Promise<string>;
  /** Makes the project's commits signed by an address GitHub ties to the owner (commit-identity.ts). */
  commitIdentity: (projectPath: string) => Promise<unknown>;
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
    // 1. Accounts.
    const status = await deps.vercelStatus();
    if (!status.connected) {
      if (status.error) throw new Stop({ kind: 'unavailable', message: 'Could not reach Vercel. Try again.' });
      need({ id: 'vercel-sign-in', kind: 'vercel-sign-in', message: 'Sign in to Vercel in Settings → Vercel.' });
    }
    if (!(await deps.isGitHubSignedIn())) {
      need({ id: 'github-sign-in', kind: 'github-sign-in', message: 'Sign in to GitHub in Settings → GitHub.' });
    }
    // Vercel refuses to deploy commits whose author it can't tie to the owner's GitHub account.
    // Best effort: a project the app can't configure still gets set up.
    await deps.commitIdentity(project.path).catch(() => undefined);

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

    // Push: only into a repo the app created, until the Vercel project exists (it builds from it).
    if (repo.createdByApp && !settings.vercel) {
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

    // 3. Vercel project.
    enter('vercel');
    const fullRepo = `${repo.owner}/${repo.repo}`;
    const choice = settings.vercelChoice;
    // the database belongs to this Vercel project: a different one must not inherit the record
    const previousProjectId = settings.vercel?.projectId;
    if (settings.vercel) {
      const { projectId, projectName, teamId } = settings.vercel;
      const recorded = await deps.vercelClient(teamId ? { teamId } : {}).findProject(projectId);
      if (!recorded) {
        if (!choice?.createNew) {
          throw new Stop({
            kind: 'not-found',
            message: `The Vercel project "${projectName}" can't be found${teamId ? ' (its team may be gone, or your account has no access to it)' : ''}. Create a new one, or check Vercel.`,
          });
        }
        await record({ vercel: undefined });
      }
    }
    if (!settings.vercel) {
      const pending = settings.pendingVercel;
      const teamId = pending?.teamId ?? deps.vercelTeamId;
      const client = deps.vercelClient(teamId ? { teamId } : {});
      /** Linked to this repo and created after the app asked for it. */
      const ours = (p: { createdAt?: number; link?: { repo: string } } | null, req: { at: string }) =>
        !!p &&
        p.link?.repo?.toLowerCase() === fullRepo.toLowerCase() &&
        typeof p.createdAt === 'number' &&
        p.createdAt >= Date.parse(req.at) - ADOPT_SKEW_MS;

      let found: { id: string; name: string } | null = null;
      if (choice?.useProjectId) {
        found = await client.findProject(choice.useProjectId);
        if (!found) throw new Stop({ kind: 'not-found', message: "The Vercel project you chose can't be found." });
      } else {
        if (pending) {
          const p = await client.findProject(pending.name);
          if (p && ours(p, pending)) found = p;
        }
        if (!found && !choice?.createNew) {
          const existing = await client.listProjectsForRepo(fullRepo);
          if (existing.length > 0) {
            need({
              id: 'vercel-existing-project',
              kind: 'vercel-existing-project',
              message: `Vercel already has a project for ${fullRepo}: ${existing.map((p) => p.name).join(', ')}. Use it, or create a new one.`,
              projects: existing.map((p) => ({ id: p.id, name: p.name })),
            });
          }
        }
        const base = vercelNameFor(repo.repo);
        for (let attempt = 1; attempt <= MAX_PROJECT_NAME_TRIES && !found; attempt++) {
          const name = attempt === 1 ? base : `${base.slice(0, 97)}-${attempt}`;
          if (await client.findProject(name)) continue;
          const req = { name, at: now().toISOString(), ...(teamId ? { teamId } : {}) };
          await record({ pendingVercel: req });
          try {
            found = await client.createProject({ name, repo: fullRepo });
          } catch (e) {
            if (isVercelError(e) && e.kind === 'conflict') {
              const p = await client.findProject(name);
              if (p && ours(p, req)) found = p;
              continue;
            }
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
      }
      await record({
        vercel: { projectId: found.id, projectName: found.name, ...(teamId ? { teamId } : {}) },
        pendingVercel: undefined,
        vercelChoice: undefined,
        ...(found.id !== previousProjectId ? { database: undefined, pendingDatabase: undefined } : {}),
      });
    }

    // 4. Enabled.
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

/** Production wiring: the real GitHub/Vercel functions and the project store. Imported lazily (Electron). */
export async function createSetupDeps(
  project: Project,
  extra: Pick<SetupDeps, 'onProgress' | 'vercelTeamId'> = {},
): Promise<SetupDeps> {
  const [credential, vercelApi, githubWrite, appAccess, tokenStore, store, identity] = await Promise.all([
    import('./vercel-credential'),
    import('./vercel-api'),
    import('./github-write'),
    import('../github-auth/app-access'),
    import('../github-auth/token-store'),
    import('../project-store'),
    import('./commit-identity'),
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
    githubLogin: () => githubWrite.getAuthenticatedLogin(),
    commitIdentity: (p) => identity.ensureCommitIdentity(identity.gitCommitIdentityDeps(p, () => githubWrite.getAuthenticatedUser())),
    inspectRepo: (owner, repo) => githubWrite.inspectRepo(owner, repo),
    saveSettings: (patch) => saveDeployPatch(store.projectStore, project.id, patch),
    ...extra,
  };
}
