# Where things live on disk

| Path | What |
|---|---|
| `<project>/.vibe-teamlead/specs/<id>/` | Everything about a task: `spec.md`, `requirements.json`, `implementation_plan.json`, `architecture/` (md, ADRs, diagrams + PNG), `qa_report.md`, `MANUAL_TEST_PLAN.md`, `task_logs.json`, security results. |
| `<project>/.vibe-teamlead/worktrees/tasks/<id>/` | The task's worktree (branch `vibe-teamlead/<id>`). |
| `<project>/.vibe-teamlead/project_index.json` | Project Index. |
| `<worktree>/.codegraph/` | CodeGraph index. |
| `<project>/.vibe-teamlead/design-system.md`, `design-tokens.json` | Design system (if it's not in a repository file). |
| `<project>/.vibe-teamlead/specs/<id>/design_check.md` | The task's design check result. |
| `~/.vibe-teamlead/memories` | Agent memory. |
| `~/.vibe-teamlead/claude-code` | Separate Claude Code configuration for agents. |
| App data folder (Electron `userData` in `~/Library/Application Support/`) | App settings, encrypted keys. |

`.vibe-teamlead/` is added to the project's `.gitignore`.
