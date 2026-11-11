/**
 * Production fetcher for the Actions client: the GitHub App user token plus plain
 * fetch. githubFetchWithETag throws on non-2xx and hides status and headers, which
 * the client needs to classify errors, so this adapter does its own GET (redirects,
 * used by job logs, are followed by fetch).
 */
import { getValidAccessToken } from '../github-auth/token-store';
import type { GitHubFetcher } from './github-actions';

export const githubFetcher: GitHubFetcher = async (endpoint) => {
  const token = await getValidAccessToken();
  if (!token) {
    throw {
      kind: 'no-connection',
      message: 'GitHub is not connected',
    };
  }
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Vibe-Teamlead',
    },
  });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  return { status: response.status, headers: response.headers, body };
};
