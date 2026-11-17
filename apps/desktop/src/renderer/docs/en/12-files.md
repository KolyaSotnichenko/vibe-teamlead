# Where things live on disk

| Path | What |
|---|---|
| `<project>/.vibe-teamlead/specs/<id>/` | Everything about a task: `spec.md`, `requirements.json`, `implementation_plan.json`, `architecture/` (md, ADRs, diagrams + PNG), `qa_report.md`, `MANUAL_TEST_PLAN.md`, `task_logs.json`, security results. |
| `<project>/.vibe-teamlead/worktrees/tasks/<id>/` | The task's worktree (branch `vibe-teamlead/<id>`). |
| `<project>/.vibe-teamlead/project_index.json` | Project Index. |
| `<worktree>/.codegraph/` | CodeGraph index. |
| `<project>/.vibe-teamlead/design-system.md`, `design-tokens.json` | Design system (if it's not in a repository file). |
| `<project>/.vibe-teamlead/specs/<id>/design_check.md` | The task's design check result. |
| `<project>/.vibe-teamlead/specs/<id>/design/` | The task's wireframes and screens. |
| `<project>/.vibe-teamlead/design/` | The project's design library, references and imported package. |
| `~/.vibe-teamlead/worktrees/preview` | The preview's own copy of main, outside the project. |
| `~/.vibe-teamlead/memories` | Agent memory. |
| `~/.vibe-teamlead/claude-code` | Separate Claude Code configuration for agents. |
| App data folder (Electron `userData`: `~/Library/Application Support/` on macOS, `%APPDATA%` on Windows) | App settings, encrypted keys. |

`.vibe-teamlead/` is kept out of git through the repository's own exclude file (`.git/info/exclude`), so the app adds no `.gitignore` to your project and nothing for you to commit.
