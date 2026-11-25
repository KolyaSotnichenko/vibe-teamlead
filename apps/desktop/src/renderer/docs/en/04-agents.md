# Agents and their roles

Each agent is a Claude Code session with its own prompt (`apps/desktop/prompts/`), set of tools and model.

| Agent | Role |
|---|---|
| **Spec analyst** (brief_analyst) | Reads the brief and the project, asks clarifying questions (Superpowers brainstorming) and splits the whole brief into tasks, in parts when it is large; your answers, assumptions and open questions are shown on the review step. |
| **Complexity assessor** | Chooses the depth of the specification pipeline. |
| **Requirements gatherer, researcher, context, discovery** | Prepare material for the spec. |
| **Spec writer** (spec_writer) | Writes `spec.md` with ACs. |
| **Spec critic** | Looks for holes and contradictions. |
| **Architect** | Writes `architecture.md`, ADRs and diagrams; renders each diagram and fixes it. |
| **Designer** | For a task that changes UI: draws wireframes, then the screens in the design system, as HTML in the task's spec folder (see "Design before code"). |
| **Design system agent** | Extracts the project's design system from the code, or designs a new one from references and a brief. |
| **Planner** | Writes `implementation_plan.json`: phases, subtasks, test-first, dependencies. |
| **Coder** | Writes code subtask by subtask (TDD), commits, updates the subtask status; keeps `RUNNING.md` (how to run the project) up to date when a subtask changes how it is installed, configured or started. |
| **QA reviewer** | Checks ACs, tests, UI (browser), security, and that `RUNNING.md` matches the change; writes the report; checks off the spec checkboxes. |
| **QA fixer** | Fixes QA issues. |
| **UX reviewer** | Goes through the running app in Preview as a person would, and lists what blocks people (see "Preview"). QA runs the same review on the pages a task changed. |
| **Preview start-up** | When the project does not start in Preview, works out why and proposes recipes that the app starts; ends with a recipe that came up, a task for the code, or what is missing (see "Preview"). No shell, no file edits. |
| **CI readiness** | Reads the project for what keeps its GitHub Actions CI from passing; the blockers become tasks (see "CI"). |
| **Merge integrator** | Brings the latest main branch into a task before it merges: resolves conflicts, runs the project's checks, fixes what the merge broke. |
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

Each subagent works in its own context and returns a short report, so the agent's own context stays on the task. These helpers never change files: they have no Write/Edit and none of the tools that change the build's state. Everything else they inherit from the agent: MCP servers (CodeGraph, Context7, memory search, the browser in QA), Superpowers skills, the web. The safety hooks (path limits, command allowlist) apply to them too.

**The agent's own subagents.** An agent can also start a subagent it needs: it calls Agent without a type and writes the instructions itself (for example, "research this library's API" or "write tests for this separate module"). That is Claude Code's built-in general-purpose subagent. It inherits all the agent's tools, editing included, so the agent is told to give it files no other subagent touches and to check its work. Subtasks of the plan still run one at a time.

While a subagent works, the task card shows how many are working (hover for their names), and in **Logs** the subagent's row has its own tool calls indented under it.

**Settings → Agent Settings → Subagents** turns them off or picks their model, for the helpers and for the agent's own subagents alike. By default they use the agent's own model. A cheaper model is usually enough for searching and running tests, but it must be served by your endpoint (for example, your gateway).

## Long command output

Every turn of an agent re-sends everything before it, so a test run that prints thousands of lines would be paid for again on every later turn. When an agent runs tests, a build, a typecheck, an install or a linter, the whole output is saved to a log in the task's folder (`.vibe-teamlead/specs/<task>/logs/`), and when it is long the agent gets a short version: the exit code, when the command failed the lines that look like failures with a few lines around them, the last lines, and the log's path, which it reads when it needs more. Short output, and commands the agent filters itself (with `|`, `>` or in the background), are left as they are. One pipe is taken away: `| tail -N` or `| head -N` on such a command. It hides the exit code and the failing lines, and in real sessions the agent then ran the same suite again a quarter of the time; the app's short version has both. The app's own checks before QA and after a merge are not affected.

## Long sessions

The designer, the coder and the QA fixer compact their conversation once it reaches about 170K tokens (instead of near the model's 1M window): Claude Code replaces the history with a summary, and the summary keeps what the role needs — for the coder the subtask, its failing test and file, the files changed and what is left; for the designer the frames done and left, your comments word for word and the design-system decisions; for the QA fixer the issues fixed and left. Each compaction rebuilds the prompt cache, so it is set high on purpose; the task log shows a line when it happens. Other agents keep Claude Code's default.
