# Agents and their roles

Each agent is a Claude Code session with its own prompt (`apps/desktop/prompts/`), set of tools and model.

| Agent | Role |
|---|---|
| **Spec analyst** (brief_analyst) | Reads the uploaded document and splits it into tasks. |
| **Complexity assessor** | Chooses the depth of the specification pipeline. |
| **Requirements gatherer, researcher, context, discovery** | Prepare material for the spec. |
| **Spec writer** (spec_writer) | Writes `spec.md` with ACs. |
| **Spec critic** | Looks for holes and contradictions. |
| **Architect** | Writes `architecture.md`, ADRs and diagrams; renders each diagram and fixes it. |
| **Planner** | Writes `implementation_plan.json`: phases, subtasks, test-first, dependencies. |
| **Coder** | Writes code subtask by subtask (TDD), commits, updates the subtask status. |
| **QA reviewer** | Checks ACs, tests, UI (browser), security; writes the report; checks off the spec checkboxes. |
| **QA fixer** | Fixes QA issues. |
| **Merge resolver** | Resolves conflicts during a merge. |
| **Commit message / PR description generators** | Write the commit message and the PR text. |
| **PR reviewer and specialists** | Review other people's PRs: security, quality, logic, fit with the codebase. |
| **Roadmap, competitor analysis, Ideation, Insights chat, Changelog** | Planning and knowledge utilities. |

## Subagents

The planner, coder, QA reviewer and QA fixer can hand parts of their work to helper subagents:

| Subagent | What it does | Who gets it |
|---|---|---|
| **Explorer** | Searches and reads the code and reports where things are and how they work. Read-only. | Planner, coder, QA, QA fixer |
| **Test runner** | Runs tests, lint or the build and reports only what failed. | Coder, QA, QA fixer |
| **Reviewer** | Checks the current changes against the subtask or the acceptance criteria. | Coder, QA fixer |

Each subagent works in its own context and returns a short report, so the agent's own context stays on the task. Subagents never change files, and subtasks still run one at a time, so the worktree has no conflicts.

While a subagent works, the task card shows how many are working (hover for their names), and in **Logs** the subagent's row has its own tool calls indented under it.

**Settings → Agent Settings → Subagents** turns them off or picks their model. By default they use the agent's own model. A cheaper model is usually enough for searching and running tests, but it must be served by your endpoint (for example, your gateway).
