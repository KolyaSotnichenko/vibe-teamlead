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
| **Language servers** | The coder and the QA fixer get the `LSP` tool and type diagnostics after each edit (see "Language servers" below). |
| **Superpowers** (bundled plugin) | A set of Claude Code skills: TDD, debugging, planning and more. |
| **frontend-design** (bundled plugin) | Anthropic's frontend-design skill (Apache-2.0), loaded for coder subtasks that touch UI (see "frontend-design" below). |
| **UX review** (bundled plugin) | The QA reviewer of a task that changed UI files checks the changed pages in the browser (see "UX review" below). |
| **GSAP skills** (bundled plugin) | GreenSock's official GSAP skills (MIT) for the designer and for UI coders of a project that animates with GSAP. The GSAP library itself isn't bundled (see "Design before code"). |
| **draw.io skill** (bundled plugin) | Gives the architect the draw.io diagram format. |
| **architecture skill** | The standard for the architecture document, diagrams and the review loop, for the architect. |

## Details

### Language servers

- Bundled: TypeScript/JavaScript via typescript-language-server, Python via pyright. From the machine: gopls, rust-analyzer, clangd when installed.
- The coder and the QA fixer get the `LSP` tool (go to definition, references, hover) and type diagnostics right after each edit, so they don't run the whole typecheck to see errors.
- Which servers a session gets follows the project's languages: from `project_index.json`, or a scan for package.json / pyproject.toml / go.mod / Cargo.toml.
- The task log says `LSP: typescript, python` or why there is none.
- The bundled servers run on the Node that ships with CodeGraph.
- Switch: Settings → Agent Settings.

### frontend-design

- This is Anthropic's frontend-design skill (Apache-2.0).
- Coder sessions get it when the subtask touches UI files (`.tsx`, `.css`, `.vue` …), or names no files in a project with a UI.
- API and data subtasks don't load it.
- The project's design system and the spec come first.
- The skill covers hierarchy, layout, copy and not looking templated.

### UX review

The QA reviewer of a task that changed UI files opens the changed pages in the browser (Playwright).

#### What it checks

- Pages at 375 and 1280 pixels wide.
- Pages by keyboard.
- Pages in dark mode, when the design system has one.
- Their empty, loading and error states.
- How a person reaches them.

#### What it checks against

- Vercel's Web Interface Guidelines (MIT).
- Impeccable's audit and harden checklists (Apache-2.0).
- The design system and the spec come first.

#### What blocks approval

- A problem that stops a person from using the page blocks approval.
- Matters of taste go under "UX notes" in the report.
- Tasks without UI changes don't load it.
