# Vibe Teamlead 2.0

**Give it a spec. Watch a team of Claude Code agents build the app — from plan and architecture to a working, tested build.**

Vibe Teamlead is a macOS desktop app that runs a team of AI agents on your project. You describe what you want; the agents write the specification, plan the architecture, implement the work in parallel, test it and review it — and you watch every step live.

> Status: 2.0 is in active development. The first public build will be macOS only.

## How it works

```
Your spec ─▶ Spec team ─▶ Planner ─▶ Coders (parallel) ─▶ QA review ─▶ QA fix ─▶ You merge
             asks you        breaks the    each in its own       checks against      fixes what
             questions,      work into     git worktree,         acceptance          QA found
             writes spec     subtasks      test-first            criteria
```

- **Every agent is Claude Code.** Sessions run on the Claude Agent SDK, with Claude Code's own tools, subagents, skills and context management.
- **Spec-driven, test-driven.** Acceptance criteria from the spec become failing tests first; code is written to make them pass.
- **Agents ask, you answer.** When an agent needs a decision, the question shows up in the app instead of the agent guessing.
- **Isolated by default.** Each task is built in its own git worktree, so your main branch is never touched until you merge.
- **Batteries included.** Superpowers (development workflow skills) and CodeGraph (code knowledge graph) ship with the app — nothing extra to install.

## Requirements

- macOS 13+ (Apple Silicon or Intel)
- An Anthropic API key from the [Claude Console](https://console.anthropic.com/)
- Git
- Node.js 24+ (for development)

Vibe Teamlead authenticates with your API key only. It does not use a personal claude.ai login and keeps its own Claude Code configuration in `~/.vibe-teamlead/`, separate from `~/.claude`.

## Development

```bash
npm run install:all   # install dependencies
npm run dev           # run the app with hot reload
npm test              # unit tests (Vitest)
npm run typecheck     # TypeScript strict check (from apps/desktop)
```

Project layout:

```
apps/desktop/
├── prompts/              # Agent role prompts (spec, planner, coder, QA...)
└── src/
    ├── main/ai/
    │   ├── claude-code/  # Claude Agent SDK runner, hooks, MCP, subagents
    │   ├── orchestration/# Spec → plan → build → QA pipeline
    │   ├── config/       # Agent types, tools and MCP servers per agent
    │   └── security/     # Bash allowlist and path containment
    ├── renderer/         # React UI
    └── shared/           # Shared types, i18n
```

## Credits

Vibe Teamlead 2.0 started as a fork of [Auto Claude](https://github.com/AndyMik90/Auto-Claude) by AndyMik90 and contributors, licensed under AGPL-3.0. It bundles [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT) and [CodeGraph](https://github.com/colbymchenry/codegraph) by colbymchenry (MIT).

Claude and Claude Code are trademarks of Anthropic, PBC. Vibe Teamlead is an independent project and is not affiliated with or endorsed by Anthropic.

## License

[AGPL-3.0](LICENSE). If you distribute a modified version or run it as a network service, you must make your source available under the same license.
