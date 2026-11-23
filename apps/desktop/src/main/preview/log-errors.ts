/**
 * An error in a service's log that means the project did not really start, though its port
 * answers: a table or database that isn't there, a module that isn't installed, an import
 * that can't be resolved, a promise nobody caught. A server that logs one of these as it
 * starts serves errors, so the start counts as failed and the agent that fixes starts is
 * told. Only what is plainly fatal: a retry, a warning or a 404 is not. Pure.
 */

const FATAL: RegExp[] = [
  // Postgres
  /relation "[^"]+" does not exist/,
  /column "[^"]+"(?: of relation "[^"]+")? does not exist/,
  /database "[^"]+" does not exist/,
  /password authentication failed for user "[^"]+"/,
  // MySQL, SQLite
  /ER_NO_SUCH_TABLE: Table '[^']+' doesn't exist/,
  /\bno such table: \S+/,
  // Node and Vite
  /Cannot find (?:module|package) '[^']+'/,
  /Failed to resolve import "[^"]+"/,
  /UnhandledPromiseRejection/,
];

const MAX_LINE = 200;

/** The first fatal error in a log, as one short line, or null */
export function errorInLog(log: string): string | null {
  // No terminal colours; quotes a JSON logger escaped read as plain quotes
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes start with ESC
  const text = log.replace(/\u001b\[[0-9;]*m/g, '').replace(/\\"/g, '"');
  let first: { at: number; line: string } | null = null;
  for (const pattern of FATAL) {
    const found = pattern.exec(text);
    if (!found || (first && found.index >= first.at)) continue;
    const end = text.indexOf('\n', found.index);
    let line = text.slice(found.index, end < 0 ? undefined : end).trim().replace(/,$/, '');
    // The closing quote of the JSON string the message sat in
    if ((line.match(/"/g) ?? []).length % 2 === 1 && line.endsWith('"')) line = line.slice(0, -1);
    first = { at: found.index, line: line.slice(0, MAX_LINE) };
  }
  return first?.line ?? null;
}
