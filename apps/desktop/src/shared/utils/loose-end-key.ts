import type { LooseEnd } from '../types/project';

/** What an owner's "leave it" is kept as: file and text, so it holds when the line moves. */
export function looseEndKey(end: LooseEnd): string {
  return `${end.file}\n${end.text}`;
}
