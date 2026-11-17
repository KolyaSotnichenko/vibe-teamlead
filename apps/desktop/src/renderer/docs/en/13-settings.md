# Settings — cheat sheet

Settings save by themselves when you leave a section or close Settings (×, Escape or a click outside); there is no Save button. The header shows "Saving…" and "Saved". If a save fails, Settings stays open with the error; closing it again discards the changes that weren't saved.

| Section | What's there |
|---|---|
| **Appearance / Display / Language** | Theme (light/dark/system), scale, language (Ukrainian/English). |
| **Developer Tools** | IDE and terminal for "open in…", YOLO mode for manual terminals. |
| **Terminal Fonts** | Terminal fonts. |
| **Claude** | Access mode (API key / subscription), keys, base URL, connection test. |
| **Tools** | Status of bundled and external tools (scanners, Chrome, Docker, Strix, CodeGraph; on Windows also Git for Windows, which agents and app checks need to run commands). |
| **Agent Settings** | Model profile, phase and feature models, Architect, formatting, language servers, Security QA (Strix) (see "Agent Settings" below). |
| **Memory** | Enable/disable, embedding model. |
| **Paths / Updates / Notifications / Debug** | Paths, updates, notifications, diagnostic logs. |
| **Telegram** | Your own Telegram bot: token, pairing, which notifications it sends, the morning digest. See the Telegram page. |
| **Project → General** | The project's agent model, CLAUDE.md, the app's own checks (commands and variables, see "Quality and security"), notifications. |
| **Project → GitHub / GitLab / Linear** | Repository, token, base branch, branch pushing, issue sync. |
| **Setup wizard** | First run: Claude, tools, Dev Tools, privacy, memory, accounts. You can run it again (see "Setup wizard" below). |

## Details

### Agent Settings

- Model profile, phase and feature models.
- Architect: every task / complex tasks only / never.
- Format and lint after each edit: the project's own prettier/ESLint, Biome, ruff or gofmt on every file the coder writes. On by default.
- Language servers for agents: bundled TypeScript and Python servers, gopls/rust-analyzer/clangd when installed. On by default; turn off on very large repositories if memory is a problem.
- Security QA (Strix) with its own model and key from a provider of your choice.

### Setup wizard

#### Steps

- First run: Claude, tools, Dev Tools, privacy, memory, accounts.
- You can run it again.

#### GitHub step

- The accounts step has an optional GitHub sign-in.
- If skipped, connect it later in Project → GitHub, or from the CI tab.
- Leaving the step cancels a sign-in in progress.
- GitHub takes two steps: signing in, then installing the Vibe Teamlead app on GitHub and choosing the repositories it may use.
- The wizard asks for the second step and checks again when you come back.
- To add a repository later, open https://github.com/settings/installations, choose the Vibe Teamlead app and add it.

## Updates

The app downloads an update by itself. It then restarts after a 10-second countdown, which **Later** stops; what you put off installs when you quit the app. While agents are running it waits for them to finish, because a restart would stop them.
