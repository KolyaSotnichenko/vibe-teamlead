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
