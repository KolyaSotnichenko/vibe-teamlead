# Changelog

Notable changes to Vibe Teamlead. Versions follow [Semantic Versioning](https://semver.org).

## 2.0.0-beta.39 - 2026-11-12

- Task cards are laid out anew: the title gets up to three lines, the status, priority and time sit in a row under the progress that wraps instead of overlapping, the preview has its own row, and the bottom strip holds only buttons. Long labels (Ukrainian ones included) are cut with an ellipsis instead of running into each other. Only urgent and high priority get a coloured chip.
- Deploy → Readiness: tasks for blockers now wait in the queue and start as the project's parallel-task limit allows, instead of all at once. The urgent fix for a failed run on main still starts right away.
- Variables the deployed app needs (secrets, allowed origins, cookie settings, …) are listed under Needed from you instead of becoming tasks. Before deploy is set up the list says to set it up first; after that each one has a button to add its value, and a notice says how many are still missing.

## 2.0.0-beta.38 - 2026-11-12

- Previews on task cards: once deploy is set up on a private repository, each task gets its own Vercel preview. The card shows **Preview** with a spinner while it builds, **Preview ↗** when it's ready (hover shows the link and build time) and **Preview failed** when the build failed (opens Vercel's build log, or the failed run in Deploy). The task window says the same, and how to set up deploy when it isn't.
- Task branches are pushed to GitHub after each finished subtask, after QA fixes and when the task goes to review, so the preview shows the latest code. A refused push doesn't stop the agent; the task window says why. Previews survive an app restart.
- A public repository (or one whose visibility can't be checked) never gets task branches pushed; visibility is checked again every hour.
- First-run wizard: the Accounts step connects Vercel next to GitHub.
- Settings → Agents: Haiku 5.5 and Sonnet 5.5 take a thinking level, like Opus.
- Note: Vercel builds previews from the agents' code with the Preview environment's variables. Keep live keys (payments and similar) to Production, or use test values for Preview.

## 2.0.0-beta.37 - 2026-11-12

- Deploy → Readiness: a new tab checks what stops the project from going live. It runs the first time you open Deploy, after merges into main and on **Check again**; its model is "Deploy readiness" in Settings → Agents (Sonnet by default). The tab's number counts the blockers it found.
- Blockers in the code or the GitHub Actions workflow become tasks that start by themselves and merge by themselves after QA, even with auto-merge off. The workflow is written for the project and installs what its checks need (browsers for Playwright and browser-mode unit tests, services, the package manager).
- A failed run on main becomes one urgent fix task with the failed jobs' logs (only your own pushes; runs from forks and pull requests are ignored). After two fixes that didn't hold, the app stops and asks you to look instead.
- When nothing blocks any more, deploy is set up by itself (not for a public repository, and not before you pick a Vercel team if your account has teams).
- Deploy → Environment: Redis (Upstash) and Blob storage can be added from Vercel; Kafka and always-running workers are listed as parts Vercel can't run.
- The readiness check never reads .env files, keys or anything outside the project.
- Setup signs the project's commits with your GitHub noreply address when git has no email, so Vercel accepts the deploys.

## 2.0.0-beta.36 - 2026-11-11

- Deploy: a numbered list on top says what is still missing (sign in to GitHub, install the GitHub App, connect Vercel, set up deploy), each with its button; it disappears once everything is done.
- Deploy → Environment: "Sign in to Vercel" from an earlier run no longer stays after Vercel is connected; the connection is read again when you come back to the app.
- Deploy → Environment: the variables a new database brings (DATABASE_URL, …) show right after it is added.
- Deploy → Runs: the run graph keeps its height when a long job log opens under it.

## 2.0.0-beta.35 - 2026-11-11

- Deploy: connect Vercel in Settings → Vercel, with a browser sign-in (the first connect downloads the Vercel CLI once, about 180 MB) or a pasted token (stored encrypted; refused when this Mac can't encrypt it). With a pasted token the CLI is downloaded on the first **Add database** instead, with progress and Cancel; it is never downloaded in the background.
- Deploy → Environment: **Set up deploy** creates a private GitHub repository when the project has none, links a Vercel project to it (an existing one or a new one) and turns on production deploys for every push to main. **Needed from you** lists the steps only you can do.
- Variables: add Vercel environment variables for Production and Preview, optionally also as a GitHub Actions secret. The value is entered once and never shown again; the list shows names only.
- Database: **Add database** adds a free Postgres (Neon) to the Vercel project; Neon's terms are accepted only when you click. Preview deployments may share the production database unless Neon's preview branching is on; the documentation says how to check.
- Main is pushed to GitHub after every merge into the project's main branch once deploy is set up. A refused push says why: GitHub has commits this Mac doesn't have, the app lacks permission, or the GitHub sign-in needs renewing. A project with an unusual git configuration is left alone with an explanation.

## 2.0.0-beta.34 - 2026-11-11

- GitHub: signing in is now followed by installing the Vibe Teamlead app on GitHub. Signing in only authorized the app, so it could reach no private repository and project setup failed with "GitHub API … returned HTTP 404". After sign-in (project setup, the first-run wizard, Deploy) Vibe Teamlead asks you to install the app and choose its repositories, and checks again when you come back. A repository the app can't see now says why (installed only on selected repositories, or not installed on the owner) with a button to fix it and **Check again**, in project setup and in Deploy.
- The window no longer scrolls: the sidebar stays put at full height and the page area scrolls by itself when a page is taller. Opening a job log in Deploy used to slide the whole window up under the title bar.
- Deploy graph: a matrix job whose name has `${{ … }}` reads "Image …" instead of the raw expression; hover it for the names of its jobs, click it to pick one. Labels wrap to two lines with the full name on hover. Deployments no longer show a meaningless duration (hover for how long ago they went live). The runs list and the page area use the app's thin, quiet scrollbar.
- GitHub PRs no longer says "GitHub Not Connected" while you are signed in. The connection check (shared with GitHub Issues) and the PR requests now use the same sign-in as Deploy, refreshing an expired GitHub App token instead of treating it as missing, and the PRs page checks again when you open it.
- GitHub Issues restyled in the app's design: title and repository in the header with the open count, the Auto-fix switch, a normal-size Analyze & group and refresh; search with an Open / Closed / All switch instead of a dropdown; the selected issue marked with a thin left bar; one primary Create task under the issue's state and details. Dates are in the app's language. GitHub PRs, GitLab Issues and GitLab merge requests follow the same layout (merge requests: New merge request in the header instead of a full-width button at the bottom).

## 2.0.0-beta.33 - 2026-11-11

- First-run wizard: an optional Accounts step between Memory and Done signs you in to GitHub in the browser (for pushing branches, pull requests and, later, deploy). Skip it and connect later in the project's settings, under GitHub.
- Deploy view (sidebar, Y): the latest GitHub Actions runs of the project's repository with a live graph of each run's jobs and stages, steps while a job runs, its log once it finishes, and the deploy stage and production link from GitHub Deployments. Approve the app's new GitHub permissions once at github.com/settings/installations. Setting up hosting, the readiness check and previews come later.

## 2.0.0-beta.32 - 2026-11-11

- Design system, Path C: import a designer's design-system package (a zip or a folder). Its tokens are taken exactly, one design-system agent run writes the document, components are rebuilt in the project's own code on first need, logos and fonts are committed with the code, and you choose Light only or Light and dark. Package scripts never run.

## 2.0.0-beta.31 - 2026-11-11

- No more "Needs Recovery" after a restart. Tasks that were running when the app closed, updated or crashed are stopped at the next launch the way Stop stops them: a task with a plan waits in review with Resume, one without a plan goes back to the backlog. Nothing restarts by itself, so nothing spends tokens until you press Resume.
- Memories no longer have Verify: marking an entry as verified changed nothing the agents see. Remove a wrong entry instead.

## 2.0.0-beta.30 - 2026-11-11

- Context → Memories shows the project's whole memory, not just the last 20 entries: filter by who wrote an entry (agents chose to remember, or learned from subtasks), by type, or by any text, file name or task number, 50 at a time with Show more. Remove a wrong entry with the bin icon on its card.

## 2.0.0-beta.29 - 2026-11-11

- No more orphaned Playwright and Chrome processes. When an agent session is cut short (a stopped task, the app quit mid-QA, a UX review stopped with the preview), the browser server it started could keep running. The app now stops its own browser servers whose session is gone, with the browsers they started: at launch, after a task's process ends, and when the preview stops. Other Playwright or Chrome processes are never touched.

## 2.0.0-beta.28 - 2026-11-10

- Project memory saves what each coder subtask learned again. Taking the lessons ran inside the task's worker, which could not find the bundled Claude Code, so it failed every time (the task's log now says "saved N lessons" or "nothing new").

## 2.0.0-beta.27 - 2026-11-10

- Flow arrows no longer cover the design: they show for the frame under the pointer (or the one you click), in and out; a frame's title shows how many transitions leave it, and Show all flows draws the whole map.
- Run prototype is now Play prototype.

## 2.0.0-beta.26 - 2026-11-10

- Prototype flows: the designer links the screens like a real flow, and the canvas draws an arrow from each link to the screen it opens (Show flows / Hide flows). Run prototype starts at the first screen of the flow, follows the pages you click through with a Back button, keeps the page when you change the width, and a click beside a link highlights what is clickable. The coder builds the design's links as the app's navigation and one responsive page per screen; QA walks every link of the design in the built app, and a missing transition blocks.

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
