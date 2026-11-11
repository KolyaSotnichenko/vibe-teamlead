import type { GitHubIssue } from '../../../../shared/types';

/** Dates on the Issues pages, in the UI language (see lib/format-date). */
export { formatDate } from '../../../lib/format-date';

export function filterIssuesBySearch(issues: GitHubIssue[], searchQuery: string): GitHubIssue[] {
  if (!searchQuery) {
    return issues;
  }

  const query = searchQuery.toLowerCase();
  return issues.filter(issue =>
    issue.title.toLowerCase().includes(query) ||
    issue.body?.toLowerCase().includes(query)
  );
}

// Re-export GitHub error parser utilities
export {
  parseGitHubError,
  isRateLimitError,
  isAuthError,
  isNetworkError,
  isRecoverableError,
  requiresSettingsAction,
} from './github-error-parser';
