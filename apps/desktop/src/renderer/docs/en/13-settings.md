# Settings — cheat sheet

| Section | What's there |
|---|---|
| **Appearance / Display / Language** | Theme (light/dark/system), scale, language (Ukrainian/English). |
| **Developer Tools** | IDE and terminal for "open in…", YOLO mode for manual terminals. |
| **Terminal Fonts** | Terminal fonts. |
| **Claude** | Access mode (API key / subscription), keys, base URL, connection test. |
| **Tools** | Status of bundled and external tools (scanners, Chrome, Docker, Strix, CodeGraph). |
| **Agent Settings** | Model profile, phase and feature models, Architect (every task / complex tasks only / never), Format and lint after each edit (the project's own prettier/ESLint, Biome, ruff or gofmt on every file the coder writes; on by default), Language servers for agents (bundled TypeScript and Python servers, gopls/rust-analyzer/clangd when installed; on by default, turn off on very large repositories if memory is a problem), Security QA (Strix). |
| **Memory** | Enable/disable, embedding model. |
| **Paths / Updates / Notifications / Debug** | Paths, updates, notifications, diagnostic logs. |
| **Project → General** | The project's agent model, CLAUDE.md, notifications. |
| **Project → GitHub / GitLab / Linear** | Repository, token, base branch, branch pushing, issue sync. |
| **Setup wizard** | First run: Claude, tools, Dev Tools, privacy, memory. You can run it again. |

## Updates

The app downloads an update by itself. It then restarts after a 10-second countdown, which **Later** stops; what you put off installs when you quit the app. While agents are running it waits for them to finish, because a restart would stop them.
