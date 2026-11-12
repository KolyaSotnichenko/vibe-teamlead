/** Length caps for text from a model or from GitHub before it goes into a task, a prompt or the UI. Pure. */

/** At most `max` characters; a cut ends with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** One line (newlines become spaces), at most `max` characters. */
export function clipLine(text: string, max: number): string {
  return clip(text.replace(/\r\n|[\r\n]/g, ' '), max);
}
