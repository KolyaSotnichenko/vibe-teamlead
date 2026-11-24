# App screens

## Build

| Screen | What's there |
|---|---|
| **Team now** (sidebar) | The pixel teamlead shows what the team is doing and, while an agent is waiting for your answer, a row that opens the question (see "Team now" below). |
| **Project tabs** (top) | Open projects; the "+" adds one. Next to it: tokens spent on the project (and the Anthropic API cost); click for the breakdown (see "Project tabs" below). |
| **Kanban Board** | Tasks by column: *Planning → Queue → In Progress → AI Review → Human Review → Done*. The board updates live (see "Kanban Board" below). |
| **Agent Terminals** | Claude Code terminals, each in its own worktree, for manual work alongside the agents. New terminal: ⌘T on macOS, Ctrl+T on Windows. |
| **Preview** | The project's app from the main branch, running inside the window: see what the agents built without starting anything. It runs only while Preview is open (see "Preview"). |
| **CI** | The GitHub Actions runs of the project's repository, live: each run's job graph, the steps and log of a job, what keeps CI from passing and the secrets it needs (see "CI"). |
| **Worktrees** | An isolated copy of the repository for each task: how many commits ahead, how many files changed. This is also where you find Merge, Create PR, Copy Path and Delete. Folders left behind after a failed cleanup are marked as orphaned. |
| **GitHub Issues / PRs**, **GitLab Issues / MRs** | Appear when GitHub or GitLab is connected: turn an issue into a task, AI review of pull requests. |

### Team now

- The pixel teamlead shows what the team is doing, one mood at a time, by priority: an error, a question for you, a task to review, work, QA, the queue, rest.
- After an hour with nothing going on he falls asleep; after a merge he jumps for joy.
- He waves when the app opens; click him to say hi.
- He chirps like a droid when an agent asks a question, a task is ready or fails, and after a merge.
- The voice is turned off in Settings → Notifications → Teamlead voice.
- While an agent is waiting for your answer, a vermilion row under him opens the question. The counts of tasks are in the status bar.

### Project tabs

- The tabs are the open projects; the "+" adds one.
- Next to it: tokens spent on the project (and the Anthropic API cost). Click for the breakdown by kind of token and by agent.
- Subscription tokens are counted but not priced.
- While the board is open, the refresh icon next to it reloads the tasks.

#### Prices through a gateway

- Through a gateway, enter what it charges per million tokens for each model in that breakdown. The models are the ones set in Settings, and any that have run.
- A new price counts from that day, and earlier sessions keep the old one.
- You then see the dollars per model, per task and per kind of token.
- The app has no gateway prices of its own, and a model without a price stays out of the total.

### Kanban Board

- Tasks by column: *Planning → Queue → In Progress → AI Review → Human Review → Done*.
- A task with a pull request shows in *Done*, a task in error in *Human Review*.
- The board updates live.
- Queued tasks start on their own, within the limit on parallel tasks.
- When the queue is paused (the Telegram `/stop_all` command), the Queue column says **Paused** with **Resume**, and no queued task starts.
- The ⋮ menu on a card moves the task to another column or deletes it (after a confirmation; a running task is stopped first).

## Plan

| Screen | What's there |
|---|---|
| **Roadmap** | Product roadmap: the agents analyze the project (and, optionally, competitors) and propose features by priority. A feature can be turned into a task. |
| **Ideation** | Idea generation by type: code improvements, quality, documentation, performance, security, UI/UX. An idea can be turned into a task. |
| **Insights** | A chat about your code. The agent reads the project (through CodeGraph and files), sees the memory and can remember new things. You can see which tools it calls. Paste or attach a screenshot and the agent sees it with your question (earlier screenshots in the chat it no longer sees). |

## Knowledge

The Knowledge pages are not in the sidebar: they sit on the right of the status bar at the bottom of the window — **Context** (shortcut C), **Changelog** (L), **MCP Overview** (M) and **Documentation** (H), then the Settings gear. The open one is marked as in the sidebar. On a narrow window only their icons show; hover for the name and shortcut.

| Screen | What's there |
|---|---|
| **Context → Project Index** | The project "passport": services, frameworks, test commands, ports. The Analyze Project button. |
| **Context → Memories** | What the agents have remembered about this project. |
| **Context → Design system** | The project's UI rules and tokens, the design check in QA, Storybook (see "Design system and Storybook"). Its Screens part holds the library of wireframes and screens the designer drew (see "Design before code"). |
| **Context → Architecture** | The project's cloud architecture (TerraVision, experimental): the latest designed by an architect and the latest drawn from the Terraform code after a merge, side by side; the decisions (ADRs) of merged tasks; the Design the cloud architecture button, whose task ends after the architect (see "Cloud architecture diagrams"). |
| **Changelog** | Generate a changelog from completed tasks, git history or a branch comparison. |
| **MCP Overview** | Which MCP servers and tools each agent has; your own MCP servers; toggles for Context7, Linear and browser tools. |

### Status bar

A thin line along the bottom of the whole window, under the sidebar and the page. On the left, what is happening now; click an item to open where it lives:

- **Questions for you** — an agent is waiting for your answer (vermilion); opens the question. Shown while the sidebar is collapsed; the open sidebar shows it under the teamlead.
- **Running**, **queued** and **for review** — the project's tasks being worked on, waiting in the queue and waiting for your review; open the board.
- **Queue paused** — shown while the queue starts no new task (for example after the Telegram bot's /stop_all); opens the board.
- **CI on main** — once CI is set up and the CI readiness check has recorded a run on main: passing, failing (vermilion) or no verdict; opens CI → CI readiness. The bar only shows what the app already knows; it does not ask GitHub itself.

With no project open the left side is empty, except for a question waiting. On the right are the Knowledge pages and Settings.

## Task window

| Tab | What's there |
|---|---|
| **Overview** | Description, status, subtask progress, the Start, Stop, Merge and PR buttons. A CI notice: the CI status of the task's branch, why there is none (CI not set up, public repository), or why the last push of its branch failed (see "CI" → CI on task cards). |
| **Workspace → Spec** | Acceptance criteria with QA results (✓ / ✗ / not verified) and what covers them; `spec.md` with checked checkboxes. |
| **Workspace → Plan** | The subtask dependency graph (left to right or top to bottom, toggle in the corner) and a timeline of what happened. |
| **Workspace → Architecture** | Diagrams (draw.io diagrams open in draw.io; SVGs, such as the architect's TerraVision cloud diagram, are shown too), `architecture.md` with embedded diagrams, ADRs. |
| **Workspace → Security** | Gate and Strix results: findings with severity. |
| **Design** | Wireframes and screens the designer drew for a task that changes UI: comment on a spot, approve, play the prototype, and later see how the built page differs (see "Design before code"). |
| **Workspace → Preview** | The task's own app before it merges (see "Preview"). Shown while the task waits in review. |
| **Workspace → Storybook** | The Storybook of the task's worktree — the components live, before merging (shown when the task changed UI files in the Storybook's folder). |
| **Subtasks** | The list of subtasks and their statuses. |
| **Logs** | What each agent did, by phase (planning, coding, review): tool calls, command output, errors. |
| **Files** | Spec files. |
