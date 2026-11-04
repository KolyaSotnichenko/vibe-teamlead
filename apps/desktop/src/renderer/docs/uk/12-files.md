# Де що лежить на диску

| Шлях | Що |
|---|---|
| `<проєкт>/.vibe-teamlead/specs/<id>/` | Усе про задачу: `spec.md`, `requirements.json`, `implementation_plan.json`, `architecture/` (md, ADR, діаграми + PNG), `qa_report.md`, `MANUAL_TEST_PLAN.md`, `task_logs.json`, результати безпеки. |
| `<проєкт>/.vibe-teamlead/worktrees/tasks/<id>/` | Worktree задачі (гілка `vibe-teamlead/<id>`). |
| `<проєкт>/.vibe-teamlead/project_index.json` | Індекс проєкту. |
| `<worktree>/.codegraph/` | Індекс CodeGraph. |
| `<проєкт>/.vibe-teamlead/design-system.md`, `design-tokens.json` | Дизайн-система (якщо не у файлі репозиторію). |
| `<проєкт>/.vibe-teamlead/specs/<id>/design_check.md` | Результат дизайн-перевірки задачі. |
| `~/.vibe-teamlead/memories` | Пам'ять агентів. |
| `~/.vibe-teamlead/claude-code` | Окрема конфігурація Claude Code для агентів. |
| Папка даних застосунку (Electron `userData` у `~/Library/Application Support/`) | Налаштування застосунку, зашифровані ключі. |

`.vibe-teamlead/` додається в `.gitignore` проєкту.
