# CLAUDE.md

Guidance for Claude Code when working in this repository.

Vibe Teamlead 2.0 is a macOS Electron app in which a team of Claude Code agents builds software from a spec: spec → plan → test-first implementation in isolated git worktrees → QA → merge. The user watches the agents live and answers their questions.

## Critical rules

- **Claude Code only.** Every AI call goes through the Claude Agent SDK via `apps/desktop/src/main/ai/claude-code/`:
  - pipeline agents (spec, planner, coder, QA): `runAgentSession()` in `claude-code/runner.ts`, called from the worker (`ai/agent/worker.ts`);
  - everything else (titles, commit messages, changelog, insights, ideation, roadmap, PR/MR review, merge resolution): `runClaudeTask()` in `claude-code/task.ts`.
  Never call `@anthropic-ai/sdk` or the Vercel AI SDK for model calls. The `ai` package remains only for memory embeddings (`ai/memory/embedding-service.ts`).
- **One Claude credential.** Sessions authenticate with an Anthropic API key (plus optional base URL), stored encrypted with safeStorage and resolved by `claude-code/credential.ts` (Settings → Claude). A claude.ai subscription token is accepted only in personal mode (`useClaudeSubscription` setting, off by default, owner's machine only — see `claude-code/auth.ts`); never make it the default or ship builds with it enabled. There are no provider accounts or profiles. Sessions run in an isolated environment (`buildEnv()`), with their own `CLAUDE_CONFIG_DIR` (`~/.vibe-teamlead/claude-code`), never the user's `~/.claude`.
- **Bundled tools.** The Claude Code binary, Superpowers (`apps/desktop/vendor/superpowers`), Anthropic's frontend-design skill (`apps/desktop/vendor/frontend-design`, loaded for coder subtasks that touch UI), the UX review skill (`apps/desktop/vendor/ux-review`, loaded for the QA reviewer of tasks that touch UI) and CodeGraph ship with the app; paths are resolved by `claude-code/bundled-tools.ts`. Don't require users to install anything.
- **Spec-driven, test-first.** Acceptance criteria carry IDs (`AC-n`); planner subtasks name the failing test first; coder works red → green → refactor; QA checks AC coverage. Keep prompt changes consistent with this (`apps/desktop/prompts/`).
- **QA checks.** Before every QA review the orchestrator runs hard gates (`ai/security/gates.ts`: gitleaks, OSV-Scanner); QA cannot approve with findings. Optional Security QA (`ai/security/strix.ts`, Settings → Security QA) pentests the changed code with Strix after approval; it is skipped, never failing, when Docker, Strix or an API key is missing.
- **App checks.** Before every QA review and after a merge, `ai/verification/verify-task.ts` runs the project's typecheck and tests itself, on a clean copy of what is committed, with commands from the task's base and no keys in the environment. A database named in the project's compose file is started as a throwaway container for the run (`verification/test-services.ts`; only the image is taken from the file). A failure blocks only if the check passes on the base. Agents' own reports never count as proof.
- **Design system.** UI follows `apps/desktop/design/DESIGN-SYSTEM.md` exactly (shared with Meter: ink/ground palette, vermilion only as a signal, radius 0, no shadows, Archivo + Inter Tight + IBM Plex Mono).
- **i18n.** User-facing UI text uses `react-i18next` keys (`apps/desktop/src/shared/i18n/locales/`). The locales are `en` and `uk` (Ukrainian); add or change every key in both. `uk` needs all four plural forms (`_one`, `_few`, `_many`, `_other`) wherever `en` has `_one`/`_other`; `src/shared/i18n/__tests__/locale-parity.test.ts` enforces key and placeholder parity.
- **macOS first.** Release targets are macOS arm64 and x64. Use `apps/desktop/src/main/platform/` helpers instead of `process.platform`.
- **No `console.log` in production code.**
- **User docs.** The in-app Documentation page renders `apps/desktop/src/renderer/docs/{en,uk}/NN-topic.md` (same files in both languages; a test checks parity). When a mechanism changes, update its page in both languages.

## Layout

```
apps/desktop/
├── prompts/                 # Agent role prompts
├── vendor/superpowers/      # Bundled Superpowers plugin (MIT)
├── design/DESIGN-SYSTEM.md  # Design tokens
└── src/
    ├── main/
    │   ├── ai/
    │   │   ├── claude-code/   # Agent SDK runner, task API, hooks, MCP, subagents, skills, CodeGraph, questions
    │   │   ├── agent/         # Worker thread + bridge (stream events, agent questions)
    │   │   ├── orchestration/ # Spec / build / QA pipeline
    │   │   ├── config/        # AGENT_CONFIGS: tools, MCP servers per agent type
    │   │   ├── security/      # Bash denylist, path containment (enforced as PreToolUse hooks)
    │   │   └── runners/       # Utility features (insights, roadmap, PR review, ...)
    │   ├── github-auth/       # GitHub App device flow + Keychain token store
    │   └── ipc-handlers/      # Main ↔ renderer IPC
    ├── renderer/              # React UI
    └── shared/                # Shared types, i18n
```

## Commands

```bash
npm run install:all          # from repo root
cd apps/desktop
npm run dev                  # app with hot reload
npm run typecheck
npm run lint
npm test                     # Vitest
npm run package:mac          # electron-builder (macOS)
```

## Working in this repo

- Read the code before changing it; keep changes minimal and scoped to the request.
- Add or update Vitest tests with every behavior change; run typecheck and the relevant tests before committing.
- Commit to `main` in small, described commits.
