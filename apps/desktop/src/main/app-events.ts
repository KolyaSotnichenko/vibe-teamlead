/**
 * App events other parts of the main process can listen to (the Telegram bot's notifications).
 * Emitting never changes what the emitter does: listeners run synchronously, and one that throws
 * is ignored.
 */

export interface AppEventMap {
  /** A task's branch was fully merged into the project */
  'task-merged': { taskId: string; projectId: string };
  /** An agent process exited while its task was still active; the task was stopped */
  'task-stuck': { taskId: string; projectId: string };
  /** A failed GitHub Actions run of the app's own push on main */
  'main-run-failed': { projectId: string; runId: number; name: string; url: string };
  /** The app's checks found a regression when merging a task (the merge was stopped) */
  'verification-regression': { taskId: string; projectId: string };
}

type Listener<K extends keyof AppEventMap> = (payload: AppEventMap[K]) => void;

const listeners = new Map<keyof AppEventMap, Set<Listener<never>>>();

export const appEvents = {
  on<K extends keyof AppEventMap>(type: K, listener: Listener<K>): () => void {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return () => set?.delete(listener as Listener<never>);
  },
  emit<K extends keyof AppEventMap>(type: K, payload: AppEventMap[K]): void {
    for (const listener of listeners.get(type) ?? []) {
      try {
        (listener as Listener<K>)(payload);
      } catch {
        // A listener never breaks the emitter
      }
    }
  },
};
