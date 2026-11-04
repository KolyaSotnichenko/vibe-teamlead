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
