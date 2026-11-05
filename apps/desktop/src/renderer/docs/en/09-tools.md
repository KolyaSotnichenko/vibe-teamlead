# Agent tools: MCP and skills

| What | What for |
|---|---|
| **Vibe Teamlead tools** (`mcp__vibe-teamlead__*`) | Subtask status, build progress, recording discoveries and pitfalls, QA status, memory (`search_memory`, `remember`), diagram rendering (`render_diagram`: draw.io/Mermaid → PNG). |
| **CodeGraph** (`mcp__codegraph__*`) | Code map. |
| **Context7** | Current library documentation (hosted HTTP server). Helps avoid writing against an outdated API. Optionally with the `CONTEXT7_API_KEY` key. |
| **Browser** (Playwright / Chrome DevTools MCP) | QA checks the UI. Started only when the task changed UI files. |
| **Electron MCP** | QA for Electron apps. |
| **Linear** | Working with Linear issues (if connected). |
| **Your own MCP servers** | Added in MCP Overview and assigned to agents. |
| **Superpowers** (bundled plugin) | A set of Claude Code skills: TDD, debugging, planning and more. |
| **frontend-design** (bundled plugin) | Anthropic's frontend-design skill (Apache-2.0). Coder sessions get it when the subtask touches UI files (`.tsx`, `.css`, `.vue` …), or names no files in a project with a UI. The project's design system and the spec come first; the skill covers hierarchy, layout, copy and not looking templated. API and data subtasks don't load it. |
| **architecture skill** | The standard for the architecture document, diagrams and the review loop, for the architect. |
