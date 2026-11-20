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

This file is written when you press the button in Context → Project Index (to view the passport or refresh it). The pipeline does not wait for it: each task computes the index from the code by itself, keeps its own copy in the task's spec folder, and QA reads the code again to choose its tools.

## CodeGraph — the code map

A symbol graph: functions, classes, who calls whom, what a change will affect.
- **Indexing:** automatic before an agent starts, separately for each worktree (`.codegraph/`, not committed to git). The graph updates while the agent edits code.
- **Usage:** agents ask it with one tool, `codegraph_explore`: name the symbols, files or the question, and it returns their source with line numbers, who calls them, what they call and what a change would affect. This replaces grep and reading files blindly, so it is faster and cheaper.
- **Looked up by the app:** agents don't always ask, so before a session the app asks CodeGraph itself about the files that work names and puts the answer in the agent's first message. The coder gets its subtask's files; the planner, architect and designer get the files the spec's `context.json` names; the QA reviewer and fixer get the files the task changed. A small file to change is given whole, a large one as a map: its symbols with the line each starts on and the files that use it, so the agent reads the lines it needs instead of the whole file. The index is brought up to date first, and a map that does not match the file on disk is dropped. Agents of the spec stage start before any file is named, so they only ask on their own.
- **Where to see it:** in the task logs. "CodeGraph: index ready / attached" says the graph is there. "Code context for …" says what the app gave the session (for example "9.8 KB (2 whole files, 3 CodeGraph maps)") or why it gave nothing. The line that ends each session has "CodeGraph lookups by the agent: N": how often the agent itself asked. Its calls are in the log too.

## Memory — the agents' experience

- **What:** pitfalls, patterns, notes about files, approaches that didn't work.
- **How it gets there:**
  - automatically after each subtask: a model (the Coding model) extracts takeaways from the changes (git diff) and the coder's conversation, up to 12 entries. This is an extra model call per subtask; with memory turned off it isn't made;
  - agents can deliberately record something with the `remember` tool.
- **How it's used:**
  - before the architect, planner, coder and QA start, the most relevant memories go into the prompt as hints to verify against the code;
  - while working, agents search on their own (`search_memory`);
  - the Insights chat sees the memory too.
- **Where:** locally in `~/.vibe-teamlead/memories`, separately for each project. To view it: Context → Memories. You enable it, and choose the embedding model, in Settings → Memory. Without an embedding model, or when Ollama isn't running, memory still works: entries are saved and search is keyword-based. To stop memory, turn it off in Settings → Memory, not Ollama.

- **Reviewing it:** in Context → Memories, filter by who wrote an entry (agents chose to remember / learned from subtasks), by type, or by any text, file name or task number. A wrong or outdated entry is removed with the bin icon on its card, and agents stop seeing it.

The first task in a project starts with empty memory. The benefit shows from the second or third task.
