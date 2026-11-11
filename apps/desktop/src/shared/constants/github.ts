/**
 * GitHub integration constants
 * Issue states, complexity levels, and investigation-related constants
 */

// ============================================
// GitHub Issue State
// ============================================

export const GITHUB_ISSUE_STATE_LABELS: Record<string, string> = {
  open: 'Open',
  closed: 'Closed'
};

export const GITHUB_ISSUE_STATE_COLORS: Record<string, string> = {
  open: 'bg-success/10 text-success border-success/30',
  closed: 'bg-purple-500/10 text-purple-400 border-purple-500/30'
};

// ============================================
// GitHub Complexity (for investigation results)
// ============================================

export const GITHUB_COMPLEXITY_COLORS: Record<string, string> = {
  simple: 'bg-success/10 text-success',
  standard: 'bg-warning/10 text-warning',
  complex: 'bg-destructive/10 text-destructive'
};

// ============================================
// GitHub App installation
// ============================================

/** Public slug of the Vibe Teamlead GitHub App. */
export const GITHUB_APP_SLUG = 'vibe-teamlead-app';

/** Install the app on an account and pick its repositories. */
export const GITHUB_APP_INSTALL_URL = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;

/** Where the user changes an existing installation (add a repository, accept new permissions). */
export const GITHUB_INSTALLATIONS_SETTINGS_URL = 'https://github.com/settings/installations';

/**
 * IPC error for a repository GitHub answered 404 for. With the app's user token this usually
 * means the app is not installed on the repository, so the UI explains access instead of the HTTP error.
 */
export const GITHUB_REPO_NOT_FOUND_ERROR = 'github:repo-not-found';
