# Settings — cheat sheet

| Section | What's there |
|---|---|
| **Appearance / Display / Language** | Theme (light/dark/system), scale, language (Ukrainian/English). |
| **Developer Tools** | IDE and terminal for "open in…", YOLO mode for manual terminals. |
| **Terminal Fonts** | Terminal fonts. |
| **Claude** | Access mode (API key / subscription), keys, base URL, connection test. |
| **Vercel** | The Vercel account deploys will use: **Connect Vercel** signs in in your browser (the first time, the app downloads the Vercel CLI, about 180 MB), or paste a token instead. Shows the account and its teams; **Disconnect** removes the sign-in from this Mac. |
| **Tools** | Status of bundled and external tools (scanners, Chrome, Docker, Strix, CodeGraph). |
| **Agent Settings** | Model profile, phase and feature models, Architect (every task / complex tasks only / never), Format and lint after each edit (the project's own prettier/ESLint, Biome, ruff or gofmt on every file the coder writes; on by default), Language servers for agents (bundled TypeScript and Python servers, gopls/rust-analyzer/clangd when installed; on by default, turn off on very large repositories if memory is a problem), Security QA (Strix). |
| **Memory** | Enable/disable, embedding model. |
| **Paths / Updates / Notifications / Debug** | Paths, updates, notifications, diagnostic logs. |
| **Project → General** | The project's agent model, CLAUDE.md, notifications. |
| **Project → GitHub / GitLab / Linear** | Repository, token, base branch, branch pushing, issue sync. |
| **Setup wizard** | First run: Claude, tools, Dev Tools, privacy, memory, accounts (optional GitHub and Vercel sign-ins; if skipped, connect them later in Project → GitHub and Settings → Vercel, or from the Deploy tab; leaving the step cancels a sign-in in progress). GitHub takes two steps: signing in, then installing the Vibe Teamlead app on GitHub and choosing the repositories it may use; the wizard asks for the second step and checks again when you come back. To add a repository later, open https://github.com/settings/installations, choose the Vibe Teamlead app and add it. You can run it again. |

## Updates

The app downloads an update by itself. It then restarts after a 10-second countdown, which **Later** stops; what you put off installs when you quit the app. While agents are running it waits for them to finish, because a restart would stop them.
