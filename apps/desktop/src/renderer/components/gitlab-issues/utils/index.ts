import type { GitLabIssue } from '../../../../shared/types';

/** Dates on the Issues pages, in the UI language (see lib/format-date). */
export { formatDate } from '../../../lib/format-date';

export function filterIssuesBySearch(issues: GitLabIssue[], searchQuery: string): GitLabIssue[] {
  if (!searchQuery) {
    return issues;
  }

  const query = searchQuery.toLowerCase();
  return issues.filter(issue =>
    issue.title.toLowerCase().includes(query) ||
    issue.description?.toLowerCase().includes(query)
  );
}
