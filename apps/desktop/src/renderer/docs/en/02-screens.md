# App screens

## Build

| Screen | What's there |
|---|---|
| **Team now** (sidebar) | The pixel teamlead shows what the team is doing, one mood at a time, by priority: an error, a question for you, a task to review, work, QA, the queue, rest. After an hour with nothing going on he falls asleep; after a merge he jumps for joy. He waves when the app opens; click him to say hi. He chirps like a droid when an agent asks a question, a task is ready or fails, and after a merge. The voice is turned off in Settings → Notifications → Teamlead voice. The counts are below him. |
| **Project tabs** (top) | Open projects; the "+" adds one. Next to it: tokens spent on the project (and the Anthropic API cost); click for the breakdown by kind of token and by agent. Subscription tokens are counted but not priced. Through a gateway, enter what it charges per million tokens for each model in that breakdown (the models set in Settings, and any that have run; a new price counts from that day, and earlier sessions keep the old one): you then see the dollars per model, per task and per kind of token. The app has no gateway prices of its own, and a model without a price stays out of the total. |
| **Kanban Board** | Tasks by column: *Planning → Queue → In Progress → AI Review → Human Review → Done* (plus *PR Created* and *Error*). The board updates live. Queued tasks start on their own, within the limit on parallel tasks. |
| **Agent Terminals** | Claude Code terminals, each in its own worktree, for manual work alongside the agents. New terminal: ⌘T. |
| **Preview** | The project's app from the main branch, running inside the window: see what the agents built without starting anything. It runs only while Preview is open (see "Preview"). |
| **Deploy** | The GitHub Actions runs of the project's repository, live: each run's job graph, the steps and log of a job, deployments and the production link (see "Deploy"). |
| **Worktrees** | An isolated copy of the repository for each task: how many commits ahead, how many files changed. This is also where you find Merge, Create PR, Copy Path and Delete. Folders left behind after a failed cleanup are marked as orphaned. |
| **GitHub Issues / PRs**, **GitLab Issues / MRs** | Appear when GitHub or GitLab is connected: turn an issue into a task, AI review of pull requests. |

## Plan

| Screen | What's there |
|---|---|
| **Roadmap** | Product roadmap: the agents analyze the project (and, optionally, competitors) and propose features by priority. A feature can be turned into a task. |
| **Ideation** | Idea generation by type: code improvements, quality, documentation, performance, security, UI/UX. An idea can be turned into a task. |
| **Insights** | A chat about your code. The agent reads the project (through CodeGraph and files), sees the memory and can remember new things. You can see which tools it calls. |

## Knowledge

| Screen | What's there |
|---|---|
| **Context → Project Index** | The project "passport": services, frameworks, test commands, ports. The Analyze Project button. |
| **Context → Memories** | What the agents have remembered about this project. |
| **Context → Design system** | The project's UI rules and tokens, the design check in QA, Storybook (see "Design system and Storybook"). |
| **Changelog** | Generate a changelog from completed tasks, git history or a branch comparison. |
| **MCP Overview** | Which MCP servers and tools each agent has; your own MCP servers; toggles for Context7, Linear and browser tools. |

## Task window

| Tab | What's there |
|---|---|
| **Overview** | Description, status, subtask progress, the Start, Stop, Merge and PR buttons. |
| **Workspace → Spec** | Acceptance criteria with QA results (✓ / ✗ / not verified) and what covers them; `spec.md` with checked checkboxes. |
| **Workspace → Plan** | The subtask dependency graph (left to right or top to bottom, toggle in the corner) and a timeline of what happened. |
| **Workspace → Architecture** | Diagrams (draw.io diagrams open in draw.io), `architecture.md` with embedded diagrams, ADRs. |
| **Workspace → Security** | Gate and Strix results: findings with severity. |
| **Workspace → Storybook** | The Storybook of the task's worktree — the components live, before merging (shown when the task changed UI files in the Storybook's folder). |
| **Subtasks** | The list of subtasks and their statuses. |
| **Logs** | What each agent did, by phase (planning, coding, review): tool calls, command output, errors. |
| **Files** | Spec files. |
