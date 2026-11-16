/**
 * The first message of a spec run. Whether the plan waits for the user's approval is a separate
 * thing from asking the user: "Auto-approve: true" was read by the spec agents as "don't ask",
 * and they decided a brief's open questions themselves. Pure.
 */
export function specTaskMessage(input: {
  taskDescription: string;
  projectPath: string;
  specDir?: string;
  baseBranch?: string;
  requireReview: boolean;
}): string {
  const lines = [`Task: ${input.taskDescription}`, '', `Project directory: ${input.projectPath}`];
  if (input.specDir) lines.push(`Spec directory: ${input.specDir}`);
  if (input.baseBranch) lines.push(`Base branch: ${input.baseBranch}`);
  lines.push(
    input.requireReview
      ? 'Plan approval: the user reviews the plan before coding starts.'
      : 'Plan approval: not needed; the plan goes on to coding by itself.',
    'This is only about the plan. Decisions that belong to the user (scope, business rules, third-party services, and the open questions from a brief listed in the task) are still asked with the AskUserQuestion tool; the app shows them to the user. Go on with a stated assumption only when the tool says no answer is available.',
  );
  return lines.join('\n');
}
