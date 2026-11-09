# Changelog

Notable changes to Vibe Teamlead. Versions follow [Semantic Versioning](https://semver.org).

## 2.0.0-beta.14 - 2026-11-09

- Preview needs no URL variables by hand: local addresses in `.env.example` (an API URL, a CORS origin) are pointed at the ports the preview picked, from each service's example port, `dev` script or framework default.
- A path typed in Preview's address field, such as `/login`, opens on the page's own address.
- The board names placeholders left in the product (a page that says it is a placeholder, "coming soon", "lorem ipsum") after every merge, with a task to replace each, or Leave it. A text search, no model.
- When a brief is split into tasks, the spec analyst checks how a person reaches every page from the home page and who replaces a placeholder a task leaves.
- Preview runs Python (Django, FastAPI, Flask), Ruby (Rails), PHP (Laravel) and Go projects, not only JavaScript: it proposes the services, installs dependencies with the project's own tool when they change, and runs the framework's migrations.
- UX review in QA: for a task that changed UI, the reviewer opens the changed pages in a real browser at phone and desktop widths, goes through them by keyboard, checks their empty, loading and error states and how a person reaches them, against Vercel's Web Interface Guidelines and Impeccable's audit and harden checklists. Problems that stop a person from using a page block approval.

## 2.0.0-beta.13 - 2026-11-09

- When the coder stops at a subtask and writes why (it needs code outside the task, or a decision only you can make), the task window shows that reason instead of a Resume that would stop there again. Continue without it sends the task to QA, which is told you skipped the subtask and why; Send back with an instruction gives the subtask to the coder again with what you wrote. Your decision is kept in the app, so an agent can't make one up.
- The stop no longer says "after 3 attempts" when the coder gave up after one.
- A task that stopped before QA no longer shows "Why QA did not approve".

## 2.0.0-beta.12 - 2026-11-09

- Preview, in the sidebar: the project's app from main inside the window. It starts when you open it and stops when you leave, runs the database from the compose file on its own volume, applies migrations and seeds a new database, and never uses your `.env`. The first time you confirm which services it runs.
- When a task breaks the project's tests or build, the QA fixer gets two tries instead of one, and it is shown which package failed and the error lines first.
- Run QA again gives the fixer new tries, instead of re-running the checks and handing the task back at once.

## 2.0.0-beta.11 - 2026-11-07

- A task stopped before its plan was written now gets a plan when it starts again, instead of failing in seconds.
- When a run fails, the task's log says why, even if no agent had started.

## 2.0.0-beta.10 - 2026-11-07

- The window no longer freezes for seconds at the end of a merge's checks.
- A task an error stopped partway through its plan offers Resume on its card and in its window.
- While a merge you confirmed is running, its buttons are off, so a second click can't end in a red message. The panel goes away when the merge is done.
- The app records when it stops answering and what was running, in a local file (`~/Library/Logs/Vibe Teamlead/stalls.jsonl`), to find what still slows it down.
- A task holds its slot until it is merged, so the next one starts from a main that has its work. One task at a time by default, and up to three with a warning about conflicts in the queue's settings. The Queue column says what it waits for.
- Auto-merge, a switch in the queue's settings, off by default: a task merges by itself once QA approved it and the app's checks and Security QA are clean.
- Adding a test file to a test script that already names its files no longer stops a task as tampering.
- A task's stats and file list count from where it started, so work merged into main later doesn't read as deleted by the task.

## 2.0.0-beta.9 - 2026-11-07

- After changing provider or models, you change them only in Settings: before each run a task takes what is set there. A task you picked different models for keeps them.
- Model changes in a task's edit window now reach a task that has already started.
- The model pickers offer only what your provider lists, and you can still type any model id. The Built-in group is gone.
- A check or install that ran out of time gets a second try, so a slow machine doesn't count as a broken task.
- Databases agents start with `docker run` are removed along with their task.
- The app tells you when the Mac slept while agents were working, for example with the lid closed.

## 2.0.0-beta.8 - 2026-11-06

- An update installs by itself: after the download the app restarts following a 10-second countdown you can stop, and waits while agents are running. It no longer opens Settings.
- Agents can no longer run code inside the browser server, where it would skip the checks on commands and file writes. Clicks, forms and screenshots work as before.

## 2.0.0-beta.7 - 2026-11-06

- Security QA findings below the level that blocks a task become one new task on the board, without repeats, instead of staying in a report.

## 2.0.0-beta.6 - 2026-11-06

- The task shows what the app's own checks found, and its card says when they couldn't say everything, for example when Docker isn't running.
- Databases agents started from a task's folder are removed with that folder.
- The QA reviewer builds on the checks the app already ran instead of repeating them, and reads changes rather than whole files.

## 2.0.0-beta.5 - 2026-11-06

- While an agent's merge waits for review, the task shows one way to merge: the second Merge button and Ready to merge are hidden.
- Correcting a model's first price the same day replaces it, instead of leaving the mistake on all earlier sessions.
- Prices are entered as input, cache read, output, and a price that looks swapped gets a warning.

## 2.0.0-beta.4 - 2026-11-06

- The check for tampered tests no longer stops tasks by mistake. A test that runs only when a database is there, a word in a comment and a new test file's own pending test don't count as switching a test off.
- A task no longer jumps to AI Review because an agent mentioned acceptance criteria or QA in its text.

## 2.0.0-beta.3 - 2026-11-06

- The app's checks work with nothing to set up. A database named in the project's compose file is started empty for each run, migrations are applied, settings come from `.env.example`, and it is removed afterwards.
- Migrations only ever run on that temporary database, never on one an example file points at.
- A check that fails on the base too gets a second try there, so a flaky test can't hide what a task broke.
- On a pre-release, the Beta Updates switch shows on and locked, and saving settings no longer moves the app off its update channel.
- The Auto-Update Projects switch is gone: nothing read it.

## 2.0.0-beta.2 - 2026-11-06

- The app is smaller: Claude Code and CodeGraph ship once instead of twice.
- Every DMG is checked against the app when it is built. The first `2.0.0-beta.1` image was missing a file and crashed on launch; it has been replaced.

## 2.0.0-beta.1 - 2026-11-06

### Good to know
- Pre-release for macOS on Apple Silicon. It is not notarized: on first launch, macOS may ask you to allow it under System Settings > Privacy & Security.

### Merging
- Tasks of a project merge one at a time, however many are asked to merge at once.
- Before merging, the latest main branch goes into the task, in the task's own folder, so your project is never left in the middle of a merge.
- An agent that can read the whole project resolves conflicts, runs the project's checks and fixes what the merge broke. If it changed code, you review the files and its report first. If it gives up, the task goes back as it was and the app says why.
- The task card shows when a task is merging, needs checking or failed, even after its window was closed.

### Quality
- The app runs the project's typecheck and tests itself, on a clean copy of what is committed, before each QA review and after a merge. A failure blocks only if the same check passes on the commit the task started from.
- A deleted test file, a test switched off and a changed `test` or `typecheck` script block approval.
- Commands are detected for npm, pnpm, yarn, bun, Python, Go, Rust, Maven, Gradle, .NET, Ruby, PHP and Swift, or set in the project's settings.
- Semgrep runs as a QA gate when it is installed. QA reviewers can no longer change or commit project code.
- An approval holds only for the exact code that was reviewed, read in full.
- Security QA runs on a throwaway copy of the task, and the task shows when it didn't finish.
- Merging commits uncommitted work only if QA approved it.

### Cost
- The usage popover shows dollars through a gateway, per model, task and kind of token, at the prices you enter. A new price counts from the day you enter it.
- Coder sessions do one subtask and start from that subtask, its criteria and its code, not the whole plan.
- QA starts from the acceptance criteria, stops after two review rounds and reviews what changed since the last one.
- The planner checks for existing code before adding a subtask. The coder works in fewer turns and keeps full test output in a file.
- Turn limits per agent, and helper subagents and the architect are optional.

### Agents
- The coder and QA fixer get language servers and each file formatted and linted as they write it.
- CodeGraph looks up a subtask's code before its session starts.
- Dev servers and background commands run through the app and stop when the agent is done.

### Fixes
- Stopping Storybook stops Storybook itself, not only the package manager in front of it.
- A task in QA stays in the QA column when the reviewer starts a helper.
- Closing the window quits the app on macOS, and asks first while agents are working.
