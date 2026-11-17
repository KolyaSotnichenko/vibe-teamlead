/**
 * The `open-terminal` window event: a page asks the app for a new terminal in a folder
 * (Preview's "Open a terminal here"). The app switches to Terminals and opens it there;
 * nothing is typed into it.
 */

export function openTerminal(cwd: string): void {
  window.dispatchEvent(new CustomEvent<string>('open-terminal', { detail: cwd }));
}

/** Returns the unsubscribe */
export function listenOpenTerminal(handler: (cwd: string) => void): () => void {
  const onEvent = (event: Event) => {
    const cwd = (event as CustomEvent<string | undefined>).detail;
    if (typeof cwd === 'string' && cwd) handler(cwd);
  };
  window.addEventListener('open-terminal', onEvent);
  return () => window.removeEventListener('open-terminal', onEvent);
}

interface TerminalStoreLike {
  terminals: Array<{ id: string; status: string; projectPath?: string }>;
  addTerminal: (cwd?: string, projectPath?: string) => unknown;
  setActiveTerminal: (id: string | null) => void;
}

/**
 * Opens the terminal; the store refuses past the project's limit. Then the project's latest
 * live terminal is selected instead, and the caller tells the owner why nothing new opened.
 */
export function openProjectTerminal(cwd: string, projectPath: string | undefined, store: TerminalStoreLike): 'opened' | 'limit' {
  if (store.addTerminal(cwd, projectPath)) return 'opened';
  const latest = store.terminals.filter((t) => t.projectPath === projectPath && t.status !== 'exited').at(-1);
  if (latest) store.setActiveTerminal(latest.id);
  return 'limit';
}

/**
 * Settings → Claude → "Get a token": the app opens a terminal that runs the bundled Claude Code
 * with `setup-token`. The page only asks; main resolves the binary and the command line.
 */
export function openClaudeSetupToken(): void {
  window.dispatchEvent(new Event('open-claude-setup-token'));
}

/** Returns the unsubscribe */
export function listenOpenClaudeSetupToken(handler: () => void): () => void {
  window.addEventListener('open-claude-setup-token', handler);
  return () => window.removeEventListener('open-claude-setup-token', handler);
}

interface SetupTokenStoreLike {
  addTerminal: (cwd: string | undefined, projectPath: string | undefined, launch: 'claude-setup-token') => unknown;
}

/** Terminals live in a project, so one must be open; past the project's limit nothing opens. */
export function openSetupTokenTerminal(projectPath: string | undefined, store: SetupTokenStoreLike): 'opened' | 'limit' | 'no-project' {
  if (!projectPath) return 'no-project';
  return store.addTerminal(projectPath, projectPath, 'claude-setup-token') ? 'opened' : 'limit';
}
