/**
 * Sentences the main process says to the owner. They are made in English where the thing
 * happens (a container that did not come up, a service that did not start), often several
 * layers below the status that carries them, as plain strings. `say` makes such a sentence
 * and remembers which key and values it came from; `saidFor` finds that again for the
 * strings a status is about to send, so the interface can say them in its own language.
 * Text nobody `say`s (a tool's own output, git's words) stays as it is. The memory is small
 * and bounded: a sentence only has to be found between being said and being sent.
 */

import type { PreviewSayKey, SaidText } from '../shared/constants/preview-say';

const MAX_REMEMBERED = 500;
const remembered = new Map<string, SaidText>();

export function say(key: PreviewSayKey, text: string, params?: Record<string, string | number>): string {
  // Said again: it moves to the end, so the oldest are the ones forgotten
  remembered.delete(text);
  remembered.set(text, { key, ...(params ? { params } : {}), text });
  if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value as string);
  return text;
}

/** The sentences among these strings that were made with `say`, each once */
export function saidFor(texts: Array<string | undefined>): SaidText[] {
  const found = new Map<string, SaidText>();
  for (const text of texts) {
    const said = text ? remembered.get(text) : undefined;
    if (said) found.set(said.text, said);
  }
  return [...found.values()];
}
