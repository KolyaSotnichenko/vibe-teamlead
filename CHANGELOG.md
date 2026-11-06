# Changelog

Notable changes to Vibe Teamlead. Versions follow [Semantic Versioning](https://semver.org).

## Unreleased

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
