/**
 * Who the project's commits are signed by. Vercel deploys a commit from GitHub only when it can tie
 * the commit's author to the owner's GitHub account (on Hobby, always). With no git identity set,
 * git signs as `user@machine.local`, which ties to nobody, and every deploy is refused.
 *
 * During deploy setup, when the project's effective `user.email` is missing or made up from the
 * machine name, the app sets the owner's GitHub noreply address in the project's own git config
 * (`--local`, never the global one). An address the owner chose is left alone.
 */
import { execFile } from 'child_process';
import { getToolPath } from '../cli-tool-manager';
import { getIsolatedGitEnv } from '../utils/git-isolation';

type Key = 'user.email' | 'user.name';

export interface CommitIdentityDeps {
  /** The effective value (local, then global); undefined when unset. */
  readConfig: (key: Key) => Promise<string | undefined>;
  githubUser: () => Promise<{ id: number; login: string; name?: string | null }>;
  writeLocalConfig: (key: Key, value: string) => Promise<void>;
}

/** The address GitHub ties to the account whatever emails it has: `<id>+<login>@users.noreply.github.com`. */
export function noreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/** False for an empty value and for addresses git makes up from the machine name (no real domain). */
export function isLinkableEmail(email: string | undefined): boolean {
  const m = /^[^@\s]+@([^@\s]+)$/.exec(email?.trim() ?? '');
  if (!m) return false;
  const domain = m[1].toLowerCase();
  return domain.includes('.') && domain !== 'localhost' && !/\.(local|localdomain|localhost|lan|home|internal)$/.test(domain);
}

export async function ensureCommitIdentity(deps: CommitIdentityDeps): Promise<{ changed: boolean; email: string }> {
  const current = await deps.readConfig('user.email');
  if (current && isLinkableEmail(current)) return { changed: false, email: current.trim() };
  const user = await deps.githubUser();
  const email = noreplyEmail(user.id, user.login);
  await deps.writeLocalConfig('user.email', email);
  if (!(await deps.readConfig('user.name'))?.trim()) await deps.writeLocalConfig('user.name', user.name?.trim() || user.login);
  return { changed: true, email };
}

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(getToolPath('git'), args, { cwd, env: getIsolatedGitEnv() as NodeJS.ProcessEnv, timeout: 10_000, encoding: 'utf-8' }, (err, stdout) => {
      if (!err) return resolve({ code: 0, out: String(stdout) });
      const code = (err as { code?: unknown }).code;
      // `git config --get` exits 1 when the key is unset
      if (code === 1) return resolve({ code: 1, out: '' });
      reject(err);
    });
  });
}

/** Production wiring for a project folder. */
export function gitCommitIdentityDeps(projectPath: string, githubUser: CommitIdentityDeps['githubUser']): CommitIdentityDeps {
  return {
    readConfig: async (key) => (await git(['config', '--get', key], projectPath)).out.trim() || undefined,
    githubUser,
    writeLocalConfig: async (key, value) => {
      const r = await git(['config', '--local', key, value], projectPath);
      if (r.code !== 0) throw new Error(`git config ${key} failed`);
    },
  };
}
