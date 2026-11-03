/**
 * External tools Vibe Teamlead uses and whether this Mac has them.
 * Shown in onboarding and Settings → Tools.
 */

import type { IPCResult } from './common';

export type ToolId = 'claude-code' | 'codegraph' | 'gitleaks' | 'osv-scanner' | 'chrome' | 'docker' | 'strix';

/**
 * - bundled: ships inside the app
 * - ready: installed (and running, for Docker)
 * - not_running: installed but not started (Docker)
 * - missing: not found
 */
export type ToolStatus = 'bundled' | 'ready' | 'not_running' | 'missing';

export interface ToolCheck {
  id: ToolId;
  status: ToolStatus;
  /** First line of `--version`, when cheap to get */
  version?: string;
  path?: string;
  /** Shell command that installs it (macOS / Homebrew), when it can be installed from a terminal */
  installCommand?: string;
  /** Page with installation instructions */
  installUrl?: string;
  /** What stops working without it — the UI explains this */
  neededFor: 'agents' | 'code_graph' | 'security_gates' | 'browser_qa' | 'security_qa';
  /** Optional tools never block anything; the app skips the feature and says so */
  optional: boolean;
}

export interface ToolsCheckAPI {
  check: () => Promise<IPCResult<ToolCheck[]>>;
}
