/**
 * Is the Vibe Teamlead GitHub App installed for the signed-in user?
 *
 * The device flow only authorizes the app; its user token reaches a private
 * repository only once the app is installed on the repository's owner (for
 * all repositories, or with the repository among the selected ones).
 *
 * Docs: https://docs.github.com/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token
 */

import type { GitHubAppAccess } from '../../shared/types/integrations';
import { GITHUB_APP } from './device-flow';
import { getValidAccessToken } from './token-store';

const GITHUB_API = 'https://api.github.com';
/** Pages of installations (100 each) read at most. */
const MAX_INSTALLATION_PAGES = 3;
/** Pages of selected repositories (100 each) read at most. */
const MAX_REPOSITORY_PAGES = 10;

type JsonFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'headers'>>;

interface Installation {
  id: number;
  app_slug?: string;
  account?: { login?: string } | null;
  repository_selection?: 'all' | 'selected';
}

export interface AppAccessOptions {
  fetchImpl?: JsonFetch;
  getToken?: () => Promise<string | null>;
}

/** GET a paginated GitHub list (`{ [key]: T[] }` bodies), following `Link: rel="next"` up to `maxPages`. */
async function getAll<T>(fetchImpl: JsonFetch, token: string, path: string, key: string, maxPages: number): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = `${GITHUB_API}${path}`;
  for (let page = 0; url && page < maxPages; page++) {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    const list = body?.[key];
    if (Array.isArray(list)) items.push(...(list as T[]));
    url = response.headers?.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return items;
}

/**
 * Without a repository: whether the app is installed anywhere for the user.
 * With one: whether it is installed on the repository's owner and includes the repository.
 * Returns `{ error }` when it cannot tell (not signed in, offline, GitHub error) — never a guessed "not installed".
 */
export async function getGitHubAppAccess(
  repo?: { owner: string; repo: string },
  options: AppAccessOptions = {},
): Promise<GitHubAppAccess | { error: string }> {
  const { fetchImpl = fetch as JsonFetch, getToken = getValidAccessToken } = options;
  try {
    const token = await getToken();
    if (!token) return { error: 'Not signed in to GitHub. Please sign in first.' };

    const installations = (
      await getAll<Installation>(fetchImpl, token, '/user/installations?per_page=100', 'installations', MAX_INSTALLATION_PAGES)
    ).filter((i) => i.app_slug === GITHUB_APP.slug);

    if (!repo) {
      const [first] = installations;
      if (!first) return { installed: false };
      const selection = installations.some((i) => i.repository_selection === 'all') ? 'all' : first.repository_selection;
      return selection ? { installed: true, repositorySelection: selection } : { installed: true };
    }

    const owner = repo.owner.toLowerCase();
    const installation = installations.find((i) => i.account?.login?.toLowerCase() === owner);
    if (!installation) return { installed: false, repoReachable: false };
    const selection = installation.repository_selection;
    if (selection !== 'selected') {
      return { installed: true, repositorySelection: selection ?? 'all', repoReachable: true };
    }

    const fullName = `${repo.owner}/${repo.repo}`.toLowerCase();
    const repositories = await getAll<{ full_name?: string }>(
      fetchImpl,
      token,
      `/user/installations/${installation.id}/repositories?per_page=100`,
      'repositories',
      MAX_REPOSITORY_PAGES,
    );
    return {
      installed: true,
      repositorySelection: 'selected',
      repoReachable: repositories.some((r) => r.full_name?.toLowerCase() === fullName),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not check the GitHub App installation' };
  }
}
