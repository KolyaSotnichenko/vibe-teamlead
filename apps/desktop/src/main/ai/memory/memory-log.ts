/**
 * One line in the task's log for each thing project memory does, so a memory that stays empty
 * says why (every memory step is best-effort and never stops an agent). Pure.
 */

interface Reply {
  ok: boolean;
  text?: string;
  error?: string;
}

/** After looking up memories for an agent's prompt */
export function promptMemoryLogLine(reply: Reply): string {
  if (!reply.ok) return `Project memory: couldn't look it up (${reply.error ?? 'no answer'})`;
  const count = (reply.text ?? '').split('\n').filter((line) => line.startsWith('- [')).length;
  return count ? `Project memory: ${count} in the prompt` : 'Project memory: nothing relevant yet';
}

/** After a coder session: its lessons extracted (or not) and stored (or not) */
export function insightsLogLine(subtaskId: string, insights: { failure?: string }, reply?: Reply): string {
  if (insights.failure) return `Project memory: couldn't take lessons from subtask ${subtaskId} (${insights.failure})`;
  if (!reply?.ok) return `Project memory: couldn't save subtask ${subtaskId}'s lessons (${reply?.error ?? 'no answer'})`;
  const count = Number(reply.text ?? 0);
  if (!count) return `Project memory: subtask ${subtaskId} left nothing new to remember`;
  return `Project memory: saved ${count} lesson${count === 1 ? '' : 's'} from subtask ${subtaskId}`;
}
