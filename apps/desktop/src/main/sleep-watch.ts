/**
 * A sleeping Mac wakes only for moments: agents barely move, and work after a pause
 * costs more because the model's cache has expired. Nothing in the app can keep a closed
 * lid awake, so it tells the user afterwards. No Electron imports.
 */

/** A shorter nap costs nothing worth mentioning */
const WORTH_MENTIONING_MS = 5 * 60_000;

interface SleepWatchOptions {
  running: () => string[];
  onSlept: (event: { tasks: number }) => void;
}

export function createSleepWatch({ running, onSlept }: SleepWatchOptions) {
  let asleep: { at: number; tasks: number } | null = null;

  return {
    suspend() {
      asleep = { at: Date.now(), tasks: running().length };
    },
    resume() {
      const slept = asleep;
      asleep = null;
      if (slept && slept.tasks > 0 && Date.now() - slept.at >= WORTH_MENTIONING_MS) onSlept({ tasks: slept.tasks });
    },
  };
}
