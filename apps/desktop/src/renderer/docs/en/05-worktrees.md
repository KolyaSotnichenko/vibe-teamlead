# Worktrees, branches, merging and PRs

- **A separate copy for each task.** Each task works in its own git worktree in `.vibe-teamlead/worktrees/tasks/<spec-id>/`, on the branch `vibe-teamlead/<spec-id>`. Your working copy is not touched until you decide to merge.
- **Protection in the agents themselves.** Agents are confined to their copy: path checks and the bash command allowlist run as Claude Code hooks, so an agent cannot write outside the worktree or run dangerous commands.
- **Merge** moves the changes into the main branch (the one selected in the project settings, otherwise detected automatically). The merge resolver helps resolve conflicts. After a full merge, the task's worktree and branch are deleted.
- **Stage-only merge.** There is a mode where the changes are only staged in the index, so you can commit them manually.
- **Create PR** pushes the task branch and opens a PR through `gh`. It needs a GitHub remote (`origin`); without one the button is disabled.
- **Cleanup is safe.** It never deletes a branch that is not a task branch.
