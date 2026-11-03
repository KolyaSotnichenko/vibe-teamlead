/**
 * Credentials for Claude Code sessions.
 *
 * Default: Anthropic API key (Claude Console).
 *
 * Personal mode (Settings → "Use my Claude subscription", off by default):
 * a Claude subscription OAuth token (`sk-ant-oat…`, e.g. from
 * `claude setup-token`) is passed to Claude Code as CLAUDE_CODE_OAUTH_TOKEN.
 * Meant only for the owner's own machine — never enable it in builds given
 * to other people (Anthropic does not allow third-party products to offer
 * claude.ai login without approval).
 */

import type { ClaudeAuth } from '../session/types';

export function isSubscriptionToken(key: string | undefined): boolean {
  return !!key && key.startsWith('sk-ant-oat');
}

/**
 * Turn a resolved credential into session auth.
 * Subscription tokens are only accepted when personal mode is on.
 */
export function toClaudeAuth(
  key: string | undefined,
  baseURL: string | undefined,
  allowSubscription: boolean,
): ClaudeAuth {
  if (!key) return {};
  if (isSubscriptionToken(key)) {
    return allowSubscription ? { oauthToken: key } : { rejectedSubscriptionToken: true };
  }
  return { apiKey: key, baseURL };
}
