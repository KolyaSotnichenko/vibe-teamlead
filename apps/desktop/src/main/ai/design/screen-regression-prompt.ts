/**
 * What the QA reviewer is told about the project's other screens after the app's screen check
 * (preview/screen-check.ts): the ones that look different since the last merge, with their two
 * pictures, to judge; and the ones the app could not reach, whose recipe may need recording again.
 * Pure.
 */

import type { ScreenCheckResult } from '../../preview/screen-check';
import { TASK_SCREENS_FILE } from './screen-catalog';

const MAX_LISTED = 40;

export function screenCheckSection(result: ScreenCheckResult | undefined): string {
  if (!result || (!result.changed.length && !result.failed.length)) return '';
  const lines: string[] = ['## The project\'s other screens', ''];
  if (result.changed.length) {
    lines.push(
      `While the app's check ran this task's code, the app opened the project's screens in it and compared them with the pictures of the last merge. These look different (${result.unchanged} others did not):`,
      '',
      ...result.changed.slice(0, MAX_LISTED).map((c) => `- ${c.id} at ${c.width} px: before ${c.before}, after ${c.after}`),
      '',
      'Read both pictures of each. A change the task meant to make (its spec or design changes that screen, or a shared component it changed on purpose) is "expected"; anything else, a screen that lost or broke something, is a "regression": put it in your issues and reject the task.',
      'Record a verdict for each in design_compare.json, next to "screens": "regressions": [{"id":"<screen>","width":<px>,"verdict":"expected"|"regression","why":"<one line>"}]. The verdict tool refuses an approval with a changed screen without a verdict, or with a regression.',
      '',
    );
  }
  if (result.failed.length) {
    lines.push(
      'These screens could not be reached by their recorded steps, so they were not compared:',
      '',
      ...result.failed.slice(0, MAX_LISTED).map((f) => `- ${f.id} at ${f.width} px: ${f.error.replace(/\s+/g, ' ').slice(0, 200)}`),
      '',
      `If this task changed how a person gets to one of them, open it in the running app and record the new way in ${TASK_SCREENS_FILE} (see "The task's design"); otherwise say in the report that it could not be compared.`,
      '',
    );
  }
  return lines.join('\n');
}
