# Changelog

Notable changes to Vibe Teamlead. Versions follow [Semantic Versioning](https://semver.org).

## 2.0.0-beta.26 - 2026-11-10

- Prototype flows: the designer links the screens like a real flow, and the canvas draws an arrow from each link to the screen it opens (Show flows / Hide flows). Run prototype starts at the first screen of the flow, follows the pages you click through with a Back button, keeps the page when you change the width, and a click beside a link highlights what is clickable.

## 2.0.0-beta.25 - 2026-11-10

- Designs are responsive pages, like the real UI: one file per screen, shown on the canvas at phone and desktop widths, and the prototype's 390 / 768 / 1280 buttons resize the page live. Before, each width was its own fixed page and the buttons only cropped it.

## 2.0.0-beta.24 - 2026-11-10

- A task started from the queue waits on its Design tab when its wireframes are ready; it showed Needs Recovery instead. Recover such a task once after updating: it goes straight to waiting, without drawing again.
- The task's Logs have a Design part, between planning and coding, with what the designer does.

## 2.0.0-beta.23 - 2026-11-10

- Design before code. For a task that changes the interface, a designer agent draws wireframes after the spec, then the screens in the project's design system, before the architecture and the plan. The task waits on its new Design tab ("Design: your turn"): click a spot on a frame to comment and send the comments for a redraw, or approve. The coder builds to the approved design; QA compares the built pages with it, and blocking differences go to the fixer. Run prototype plays any frame at phone, tablet and desktop widths, with its links and animations. On by default; Context → Design system → Setup → Design before code turns it off, to wireframes only, or lets the designer go on by itself. Its model is Designer in the feature models.
- The project's design library: every finished design goes into it, and the next task's designer starts from it. Context → Design system → Screens shows all of the project's wireframes and screens on one canvas.
- GreenSock's official GSAP skills are bundled, for the designer and for the UI coders of a project that animates with GSAP.
- Frames are shown sandboxed, with no network except Google Fonts and a pinned GSAP.

## 2.0.0-beta.22 - 2026-11-10

- Project memory reports in the task's log: how many memories went into each agent's prompt, and after each coder subtask whether its lessons were saved, there was nothing new, or why they couldn't be taken or saved. Before, every memory step failed silently.

## 2.0.0-beta.21 - 2026-11-10

- When the app checks find a check that fails on main too, the app creates one urgent task that fixes main and starts it at once, past the queue. Tasks that hit the same failure while it is open don't start another; once it is merged, a main that fails again gets a new one.

## 2.0.0-beta.20 - 2026-11-10

- Design system: the brief's last field asks only for the mood; references are the step above it. Apply to the project is in Overview, under the system it compares the code with.
- A reference is digested once. Reading the list while one was being digested queued it again, so it was looked at over and over, each time a new agent session.
- WebP references get a thumbnail and measured colours: they are converted to PNG first.

## 2.0.0-beta.19 - 2026-11-09

- The Design system tab has two parts. Setup: pick path A (keep the current look: brand rules, then extract from the code) or path B (a new look: references, then a brief and three directions); each path's steps open under it, with the references where they are used. Below: applying the system to the code, the QA check and Storybook. Overview: the colours, fonts, rules and document, editable. A status line says how the system was made and how many differences the code has.
- Preview: a sign-in made while clicking through no longer sticks: stopping the preview clears the page's cookies and storage, and Reset session (next to Reload) does it on the spot.

## 2.0.0-beta.18 - 2026-11-09

- The Design system tab is one flow in three steps — references (optional), the design system, applying it to the code — with the next one marked. Without a system it starts with two paths: keep the current look (extract it from the code) or a new one (references, then three directions), and a link to a file already in the repository.
- References added after the system was written are marked "new", and a banner offers a new direction with them or an update from the "As is" ones. Until then the system's rules stay as they were.
- Apply to the project shows how many places in how many files differ from the system, the files with the most and what happens next, before anything is planned. The check runs without a model.

## 2.0.0-beta.17 - 2026-11-09

- The app checks before QA say what they are doing in the task's log: the clean copy, the database, installs and migrations, each check with its time, and the run on main when a check fails. A task in AI Review no longer looks stuck while they run.

## 2.0.0-beta.16 - 2026-11-09

- A task from Preview notes with Quick fix no longer stops after its plan: a subtask's verification written as a command string is taken as a command check instead of failing the build.
- Tasks with a Ukrainian or Russian title get a readable folder and branch name instead of "028-".

## 2.0.0-beta.15 - 2026-11-09

- Preview notes: a click in notes mode makes a note again. Keeping presses from the app's menus had stopped the clicks the overlay listens for.
- App checks start the database from the main compose file. An override such as `docker-compose.e2e.yml` sorted first and named none, so migrations were skipped and tests failed "without this task too".
- Preview Logs: each service's log, with a search; links in it open in the preview.
- Preview Mail: when the project configures SMTP, a local Mailpit catches what the app sends; nothing leaves your Mac.

## 2.0.0-beta.14 - 2026-11-09

- Preview needs no URL variables by hand: local addresses in `.env.example` (an API URL, a CORS origin) are pointed at the ports the preview picked, from each service's example port, `dev` script or framework default.
- A path typed in Preview's address field, such as `/login`, opens on the page's own address.
- The board names placeholders left in the product (a page that says it is a placeholder, "coming soon", "lorem ipsum") after every merge, with a task to replace each, or Leave it. A text search, no model.
- When a brief is split into tasks, the spec analyst checks how a person reaches every page from the home page and who replaces a placeholder a task leaves.
- Preview runs Python (Django, FastAPI, Flask), Ruby (Rails), PHP (Laravel) and Go projects, not only JavaScript: it proposes the services, installs dependencies with the project's own tool when they change, and runs the framework's migrations.
- Preview notes: click an element or drag over an area in the running app, write what should change, and send the notes as one task, with screenshots and the source location where the framework knows it. Quick fix, the default, takes a short path to code.
- UX review in Preview: one agent session goes through the whole app from its home page and lists what stops people, with a task per finding or one for everything that blocks. Its model is a feature setting.
- A task's Preview: while a task waits in review, its window runs the task's own code on a copy of the preview data; notes there go back into the task.
- UI tasks wait for my preview: with auto-merge on, an approved task that changed UI waits in review for you to look at it.
- Apply a changed design system to a built project: Design system → Plan the redesign checks every UI file against it, without a model, and opens the spec import with a redesign brief for the spec analyst to split into tasks you review.
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
