/**
 * The sentences the main process says to the owner in the Preview, each with the values it
 * carries. The interface translates them by key (`preview.say.<key>` in the locales); the
 * English sentence made in the main process is what logs keep and what is shown when a key
 * is missing. One list, so a new sentence can't be added without its translations
 * (i18n/__tests__/preview-say-keys.test.ts).
 */
export const PREVIEW_SAY = {
  // The compose file's services (ai/verification/compose-runner.ts)
  composeDockerMissing: ['names'],
  composeNetworkFailed: ['output'],
  composeNeeds: ['name', 'missing'],
  dockerNotStarted: ['image', 'output'],
  dockerNoPort: ['image'],
  composeStoppedAtStart: ['name', 'image'],
  composeNotReady: ['name', 'image'],
  composeBucketFailed: ['bucket', 'name'],
  runStopped: [],
  composeMoved: ['name', 'wanted', 'got'],
  composeMovedSibling: ['name', 'wanted', 'got', 'heldBy'],
  // The preview's database and mail catcher (preview/preview-database.ts, preview-mail.ts)
  dbDockerMissing: ['kinds'],
  imageNotReady: ['image'],
  previewStopped: [],
  resetFailed: ['output'],
  mailDockerMissing: [],
  mailNotStarted: ['image'],
  mailNoPorts: [],
  // A start that failed, and what it left out (preview/preview-session.ts)
  needsServices: [],
  installFailed: ['tool'],
  libraryFailed: ['name'],
  migrationsFailed: [],
  depsFailed: ['dir'],
  depsFailedRoot: [],
  commandFailed: ['command'],
  seedFailed: [],
  serviceNotStarted: ['service'],
  notReady: ['service', 'path', 'answer'],
  stoppedBeforeReady: ['service'],
  heldBack: ['names'],
  // A recipe made in the app (preview/settle-pending-recipe.ts)
  editDropped: [],
  noRecipeToChange: [],
  // Why a project's preview.json was not used (preview/recipe.ts)
  recipeTooLarge: [],
  recipeNotJson: [],
  recipeShape: ['at', 'problem'],
  recipeUnknownKeys: ['at', 'keys'],
  recipeSameName: [],
  recipeOnePage: [],
  recipeDir: ['at'],
  recipeCommand: ['at', 'reason'],
  recipeVariable: ['at'],
  recipeUrlEnv: ['at', 'target'],
  recipeLink: ['dir'],
} as const satisfies Record<string, readonly string[]>;

export type PreviewSayKey = keyof typeof PREVIEW_SAY;

/** A sentence from the main process: its key, its values, and the English text it was said in */
export interface SaidText {
  key: PreviewSayKey;
  params?: Record<string, string | number>;
  text: string;
}
