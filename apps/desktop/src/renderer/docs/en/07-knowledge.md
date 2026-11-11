# Project Index, CodeGraph and memory

These are three different things (the fourth, the design system, has its own page).

## Project Index — the "passport"

`.vibe-teamlead/project_index.json` describes the project as a whole:
- which services it consists of, their languages and frameworks;
- run, test and build commands, ports, Docker;
- the app type (web, Electron, backend).

Who uses it:
- the spec, architecture, plan and QA agents, to plan for the real structure;
- the app, to decide which tools to provide (a browser for QA, whether Strix is needed).

It is recomputed from the code automatically before QA. The button in Context → Project Index is there to view the passport or refresh it manually.

## CodeGraph — the code map

A symbol graph: functions, classes, who calls whom, what a change will affect.
- **Indexing:** automatic before an agent starts, separately for each worktree (`.codegraph/`, not committed to git). The graph updates while the agent edits code.
- **Usage:** agents query it (`codegraph_search`, `callers`, `impact`…) instead of grep and reading files blindly. This is faster and cheaper.
- **Where to see it:** in the task logs, the lines "CodeGraph: index ready / attached" and calls to its tools.

## Memory — the agents' experience

- **What:** pitfalls, patterns, notes about files, approaches that didn't work.
- **How it gets there:**
  - automatically after each subtask: a model extracts takeaways from the changes (git diff) and the coder's conversation, up to 12 entries;
  - agents can deliberately record something with the `remember` tool.
- **How it's used:**
  - before the architect, planner, coder and QA start, the most relevant memories go into the prompt as hints to verify against the code;
  - while working, agents search on their own (`search_memory`);
  - the Insights chat sees the memory too.
- **Where:** locally in `~/.vibe-teamlead/memories`, separately for each project. To view it: Context → Memories. You enable it, and choose the embedding model, in Settings → Memory. Without an embedding model, search is keyword-based.

- **Reviewing it:** in Context → Memories, filter by who wrote an entry (agents chose to remember / learned from subtasks), by type, or by any text, file name or task number. A wrong or outdated entry is removed with the bin icon on its card, and agents stop seeing it.

The first task in a project starts with empty memory. The benefit shows from the second or third task.
