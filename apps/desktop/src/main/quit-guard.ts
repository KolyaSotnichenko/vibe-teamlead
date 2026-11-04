/**
 * Quitting stops the agents, so while a task runs the app asks first. Closing the
 * window and Cmd+Q both end here, and a single quit asks only once.
 */

export interface QuitGuardOptions {
  running: () => string[];
  /** True when the user chose to quit */
  ask: (count: number) => boolean;
}

export function createQuitGuard({ running, ask }: QuitGuardOptions) {
  let confirmed = false;
  return {
    confirm(): boolean {
      if (confirmed) return true;
      const count = running().length;
      if (count === 0 || ask(count)) {
        confirmed = true;
        return true;
      }
      return false;
    },
  };
}

const PROMPTS = {
  en: (count: number) => ({
    message: `Agents are still working (tasks: ${count})`,
    detail: 'Closing the app stops them. The tasks stay in progress, and you can resume them later.',
    buttons: ['Keep working', 'Close and stop'],
  }),
  uk: (count: number) => ({
    message: `Агенти ще працюють (задач: ${count})`,
    detail: 'Закриття застосунку зупинить їх. Задачі лишаться незавершеними, їх можна буде продовжити пізніше.',
    buttons: ['Лишити працювати', 'Закрити й зупинити'],
  }),
};

/** The text of the question; the first button is the safe default. Pure. */
export function quitPrompt(language: string, count: number) {
  return (language === 'uk' ? PROMPTS.uk : PROMPTS.en)(count);
}
