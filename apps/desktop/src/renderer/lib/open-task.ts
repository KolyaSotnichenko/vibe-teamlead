/** Ask the app to open a task's detail on the board (from pages that list tasks, e.g. Context → Architecture). */
export function openTask(taskId: string): void {
  window.dispatchEvent(new CustomEvent<string>('open-task', { detail: taskId }));
}

/** Listens for the `open-task` window event; returns the unsubscribe. */
export function listenOpenTask(handler: (taskId: string) => void): () => void {
  const onEvent = (event: Event) => {
    const id = (event as CustomEvent<string | undefined>).detail;
    if (id) handler(id);
  };
  window.addEventListener('open-task', onEvent);
  return () => window.removeEventListener('open-task', onEvent);
}
