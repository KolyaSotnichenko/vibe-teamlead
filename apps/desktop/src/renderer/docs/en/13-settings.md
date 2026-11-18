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
| **Project → Queue** | How many tasks may be under way at once (1 by default, up to 3), auto-merge, and UI tasks waiting for your preview (see "How a task goes through the pipeline"). |
| **Project → GitHub / GitLab / Linear** | Repository, token, base branch, branch pushing, issue sync. |
| **Setup wizard** | First run: Claude, tools, Dev Tools, privacy, memory, accounts, documentation. You can run it again (see "Setup wizard" below). |

## Details

### Agent Settings

- Model profile, phase and feature models.
- Architect: every task / complex tasks only / never.
- Format and lint after each edit: the project's own prettier/ESLint, Biome, ruff or gofmt on every file the coder writes. On by default.
- Language servers for agents: bundled TypeScript and Python servers, gopls/rust-analyzer/clangd when installed. On by default; turn off on very large repositories if memory is a problem.
- Cloud architecture diagrams (TerraVision, experimental): optional, off by default; turn it on here and install uv and Graphviz (and Terraform or OpenTofu to draw from code). Everyone starts with it off, including those who had it on as the earlier default. For cloud-infrastructure tasks the architect also draws the target cloud architecture, and after merges that change Terraform the app redraws it from the code (see "Cloud architecture diagrams" in the pipeline page). A line under it says what is installed and what is missing (uv, Graphviz, Git, Terraform or OpenTofu) with an install command for each; nothing is installed for you, and without them nothing happens.
- Security QA (Strix) with its own model and key from a provider of your choice.

### Setup wizard

#### Steps

- First run: Claude, tools, Dev Tools, privacy, memory, accounts, documentation.
- You can run it again.

#### Claude step

- The same choice as in Settings → Claude: an API key (the default) or, on your own machine, a Claude subscription token with the Get a token button. The choice is saved at once. The GitHub setup dialog asks the same way.

#### Documentation step

- Before the finish, the wizard asks you to read this documentation: how the pipeline works, what the agents do, the preview and what it can't set up (Docker, outside services with their own keys), the settings and the costs.
- Open the documentation opens these pages over the wizard; close them to return to the step.
- To go on, tick "I've read the documentation, or I'll read it before starting work".

#### GitHub step

- The accounts step has an optional GitHub sign-in.
- If skipped, connect it later in Project → GitHub, or from the CI tab.
- Leaving the step cancels a sign-in in progress.
- GitHub takes two steps: signing in, then installing the Vibe Teamlead app on GitHub and choosing the repositories it may use.
- The wizard asks for the second step and checks again when you come back.
- To add a repository later, open https://github.com/settings/installations, choose the Vibe Teamlead app and add it.

## Updates

The app downloads an update by itself. It then restarts after a 10-second countdown, which **Later** stops; what you put off installs when you quit the app. While agents are running it waits for them to finish, because a restart would stop them.
