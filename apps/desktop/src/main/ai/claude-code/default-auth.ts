/**
 * Where runClaudeTask gets its credential when the caller passes none.
 *
 * The main process registers the stored credential (`credential.ts`, which
 * needs Electron); a worker thread registers the credential it was started
 * with. This module must not import Electron: it is part of the worker bundle,
 * and a worker cannot load `electron`.
 */

import type { ClaudeAuth } from '../session/types';

let provider: (() => ClaudeAuth) | undefined;

export function setDefaultClaudeAuthProvider(next: () => ClaudeAuth): void {
  provider = next;
}

/** The registered credential, or none (the session then fails with auth_failure). */
export function defaultClaudeAuth(): ClaudeAuth {
  return provider?.() ?? {};
}
