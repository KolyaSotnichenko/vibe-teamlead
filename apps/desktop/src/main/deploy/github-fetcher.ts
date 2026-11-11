/**
 * Production fetcher for the Actions client: the GitHub App user token plus plain
 * fetch. githubFetchWithETag throws on non-2xx and hides status and headers, which
 * the client needs to classify errors, so this adapter does its own GET (redirects,
 * used by job logs, are followed by fetch). Failures are thrown as GitHubError.
 */
import { getValidAccessToken } from '../github-auth/token-store';
import type { GitHubError } from '../../shared/types/deploy';
import type { GitHubFetcher } from './github-actions';

const noConnection: GitHubError = { kind: 'no-connection', message: 'GitHub is not connected' };

export const githubFetcher: GitHubFetcher = async (endpoint) => {
  let token: string | null = null;
  try {
    token = await getValidAccessToken();
  } catch {
    throw noConnection;
  }
  if (!token) throw noConnection;

  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
  try {
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
  } catch {
    const unavailable: GitHubError = { kind: 'unavailable', message: 'Could not reach GitHub' };
    throw unavailable;
  }
};
