/**
 * Whether an agent's prompt carries the whole design system or a pointer to its file.
 *
 * Every turn re-sends the system prompt, and the design system section is several thousand
 * tokens. An agent that won't touch UI gets one line saying where the file is and when to read
 * it: a coder subtask that names only non-UI files, and the QA reviewer and fixer of a task that
 * changed no UI file. Every other role keeps the whole document. Pure.
 */

export type DesignScope = 'full' | 'pointer';

const QA_ROLES = new Set(['qa_reviewer', 'qa_fixer']);

export function designScope(
  promptName: string,
  opts: { subtaskFiles?: string[]; taskTouchesUi?: boolean; isUiFile: (file: string) => boolean },
): DesignScope {
  if (promptName === 'coder') {
    const files = opts.subtaskFiles ?? [];
    return files.length > 0 && !files.some(opts.isUiFile) ? 'pointer' : 'full';
  }
  if (QA_ROLES.has(promptName) && opts.taskTouchesUi === false) return 'pointer';
  return 'full';
}

/** The pointer section ('' when there is no design system file). Pure. */
export function designPointer(promptName: string, markdownPath: string | undefined): string {
  if (!markdownPath) return '';
  const why = promptName === 'coder' ? "This subtask's files are not UI files." : 'This task changed no UI file.';
  const when = QA_ROLES.has(promptName) ? 'If a fix does change UI' : 'If you do change UI';
  return `## Design system\n\n${why} ${when}, read \`${markdownPath}\` first and follow it exactly.`;
}
