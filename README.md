# Vibe Teamlead 2.0

**Give it a spec. Watch a team of Claude Code agents build the app, from plan and architecture to a working, tested build.**

Vibe Teamlead is a desktop app that runs a team of AI agents on your project. You describe what you want or upload a spec document; the agents write the specification, design the screens, plan the architecture, build the tasks in parallel, test and review them, and you watch every step live and answer their questions.

> **Status:** public beta for macOS (Apple Silicon and Intel). A Windows x64 build is in testing. Releases and the changelog are on the [Releases page](https://github.com/KolyaSotnichenko/vibe-teamlead/releases); the app updates itself.

## How it works

```
Spec ─▶ Design ─▶ Architecture ─▶ Plan ─▶ Code (parallel) ─▶ QA ─▶ You review and merge
asks     screens   architecture.md  subtasks, each   test-first, each   checks, security
you      before    and diagrams     with its         task in its own    gates, AC coverage,
questions  code                     failing test     git worktree       fixes what it found
```

- **Every agent is Claude Code.** Sessions run on the Claude Agent SDK, with Claude Code's own tools, subagents, skills and context management.
- **Spec-driven, test-driven.** Acceptance criteria (`AC-n`) become failing tests first; code is written to make them pass, and QA checks that every criterion is covered.
- **Spec documents in, tasks out.** Upload a `.docx`, `.md`, `.pdf`, `.txt` or `.rtf` brief: the analyst asks what's unclear, splits it into epics and tasks with dependencies, and the open questions go to the agents of the tasks they affect. One answer is shared by all of them.
- **Agents ask, you answer.** When an agent needs a decision, the question shows up in the app instead of the agent guessing.
- **Isolated and parallel.** Each task is built in its own git worktree, so your main branch is untouched until you merge. A queue runs several tasks side by side within a limit you set, and can merge them for you once QA approves.
- **Checks the app runs itself.** Before every QA review the app runs your project's typecheck and tests on a clean copy of the committed code, with a throwaway database when your compose file names one, and the secret and dependency scanners (gitleaks, OSV-Scanner). An agent's own report never counts as proof.
- **Security QA (optional).** Pentests the changed code with Strix after QA approves, when Docker and Strix are available.
- **CI on GitHub.** Sets up GitHub Actions for the project, pushes main and task branches, shows each task's CI status on its card, and turns a failed run on main into one fix task.
- **Preview.** Open the running app from a task, see what changed, and leave notes on the page for the agents.
- **Batteries included.** Claude Code, CodeGraph (code knowledge graph), the security scanners, Superpowers (development workflow skills), Anthropic's frontend-design skill, a UX review skill and draw.io diagrams ship with the app. Nothing extra to install for the core.

## Install

Download the latest build from [Releases](https://github.com/KolyaSotnichenko/vibe-teamlead/releases):

- **macOS:** the `.dmg` for Apple Silicon (`arm64`) or Intel (`x64`).
- **Windows x64 (in testing):** the `.exe` installer. It isn't signed yet, so Windows SmartScreen warns on first run: choose *More info → Run anyway*. Agents on Windows need [Git for Windows](https://git-scm.com/download/win).

The app checks for updates itself and installs them on restart.

## Requirements

- macOS 13+ (Apple Silicon or Intel), or Windows 10/11 x64 (in testing)
- Git (on Windows: Git for Windows)
- An Anthropic API key from the [Claude Console](https://console.anthropic.com/), or a key for a compatible gateway with its base URL
- Optional: Docker Desktop (throwaway test databases, Security QA), Google Chrome (browser checks in QA)

Vibe Teamlead keeps its own Claude Code configuration in `~/.vibe-teamlead/`, separate from `~/.claude`. Keys are stored encrypted by the operating system. The models for each phase are set in Settings.

**Personal mode (optional):** Settings → *Use my Claude subscription* runs agents on your own Claude Pro/Max subscription instead of an API key. It is off by default and meant only for your own machine; don't enable it in builds you give to others. Subscription limits are shared with your regular Claude usage.

The interface is in English and Ukrainian. The in-app Documentation page explains every mechanism.

## Development

```bash
npm run install:all   # install dependencies (from the repo root)
cd apps/desktop
npm run dev           # run the app with hot reload
npm test              # unit tests (Vitest)
npm run typecheck     # TypeScript strict check
npm run lint          # Biome
npm run package:mac   # macOS build (electron-builder)
npm run package:win   # Windows x64 installer (on Windows, or in CI: .github/workflows/release-windows.yml)
```

Project layout:

```
apps/desktop/
├── prompts/              # Agent role prompts (spec, planner, coder, QA...)
├── vendor/               # Bundled plugins and skills
└── src/
    ├── main/
    │   ├── ai/
    │   │   ├── claude-code/   # Claude Agent SDK runner, hooks, MCP, subagents, skills
    │   │   ├── orchestration/ # Spec → plan → build → QA pipeline
    │   │   ├── verification/  # The app's own checks of a task
    │   │   ├── security/      # Gates, Bash allowlist, path containment
    │   │   └── runners/       # Spec documents, insights, roadmap, PR review...
    │   ├── deploy/            # CI on GitHub (internal name)
    │   └── ipc-handlers/      # Main ↔ renderer IPC
    ├── renderer/              # React UI and the in-app documentation
    └── shared/                # Shared types, i18n (en, uk)
```

## Credits

Vibe Teamlead 2.0 started as a fork of [Auto Claude](https://github.com/AndyMik90/Auto-Claude) by AndyMik90 and contributors, licensed under AGPL-3.0. It bundles [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT) and [CodeGraph](https://github.com/colbymchenry/codegraph) by colbymchenry (MIT).

Claude and Claude Code are trademarks of Anthropic, PBC. Vibe Teamlead is an independent project and is not affiliated with or endorsed by Anthropic.

## License

[AGPL-3.0](LICENSE). If you distribute a modified version or run it as a network service, you must make your source available under the same license.
