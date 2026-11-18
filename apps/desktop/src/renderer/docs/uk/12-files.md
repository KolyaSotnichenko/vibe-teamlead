# Де що лежить на диску

| Шлях | Що |
|---|---|
| `<проєкт>/.vibe-teamlead/specs/<id>/` | Усе про задачу: `spec.md`, `requirements.json`, `implementation_plan.json`, `architecture/` (md, ADR, діаграми + PNG), `qa_report.md`, `MANUAL_TEST_PLAN.md`, `task_logs.json`, результати безпеки. |
| `<проєкт>/.vibe-teamlead/worktrees/tasks/<id>/` | Worktree задачі (гілка `vibe-teamlead/<id>`). |
| `<проєкт>/.vibe-teamlead/project_index.json` | Індекс проєкту. |
| `<worktree>/.codegraph/` | Індекс CodeGraph. |
| `<проєкт>/.vibe-teamlead/design-system.md`, `design-tokens.json` | Дизайн-система (якщо не у файлі репозиторію). |
| `<проєкт>/.vibe-teamlead/specs/<id>/design_check.md` | Результат дизайн-перевірки задачі. |
| `<project>/.vibe-teamlead/specs/<id>/design/` | Wireframe і екрани задачі. |
| `<проєкт>/.vibe-teamlead/cloud-architecture/` | Хмарна архітектура, намальована з коду Terraform після останнього злиття, що його змінило (`latest/`: SVG, draw.io, HTML, граф), і `meta.json` (який коміт і задача, остання спроба). |
| `<project>/.vibe-teamlead/design/` | Бібліотека дизайну проєкту, референси та імпортований пакет. |
| `~/.vibe-teamlead/worktrees/preview` | Власна копія main для Preview, поза проєктом. |
| `~/.vibe-teamlead/memories` | Пам'ять агентів. |
| `~/.vibe-teamlead/claude-code` | Окрема конфігурація Claude Code для агентів. |
| Папка даних застосунку (Electron `userData`: `~/Library/Application Support/` на macOS, `%APPDATA%` на Windows) | Налаштування застосунку, зашифровані ключі. |

`.vibe-teamlead/` виключається з git через власний файл виключень репозиторію (`.git/info/exclude`), тож застосунок не додає в проєкт `.gitignore` і вам нічого не треба комітити.
