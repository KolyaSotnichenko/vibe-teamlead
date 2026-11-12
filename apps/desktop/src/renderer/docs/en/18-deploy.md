# Deploy

Deploy, in the sidebar (shortcut Y), shows what happens to your project's code after it is pushed: the GitHub Actions runs of its repository, live, and where the code went live.

Until everything is ready, a numbered list on top says what is still missing: sign in to GitHub, install the Vibe Teamlead GitHub App, connect Vercel, set up deploy for the project. Each step has its button; done steps are ticked, and the list disappears once all are done.

## Runs

The latest runs of the project's GitHub repository are listed on the left. Pick one and its graph opens on the right: the workflow's jobs, grouped into stages by their `needs`. Jobs that don't depend on each other sit in the same stage; the ones that wait for them come in the next.

Status is live. The view refreshes every 5 seconds while something is running and every 60 seconds otherwise. It refreshes only while Deploy is open and the window is visible.

Click a job to see its steps, updated while it runs. Its log, the last 2 000 lines, appears once the job finishes. GitHub keeps logs for a limited time, so an old run may say that GitHub no longer keeps its log; **Full log on GitHub** opens it there.

A job that runs several times (a matrix, such as one image per app, or a reusable workflow) is one box in the graph. Parts of its name that GitHub fills in while it runs (`${{ … }}`) show as `…`; hover the box to see the names of its jobs, and click it to pick which one's steps and log to see. A box in the **Deploy** stage shows no duration; hover or focus it to see how long ago that deployment went live (once it is live).

## Deployment and production link

The **Deploy** stage and the **Production** link come from GitHub Deployments, not from the workflow. A host that reports to GitHub, for example Vercel through its GitHub integration, shows up there with its status and its log. When nothing reports deployments, the graph shows the workflow's jobs only.

## What it needs

- **GitHub signed in, and the app installed.** These are two steps: sign in, then install the Vibe Teamlead app on GitHub and give it the repository. When you aren't signed in, the view has a **Connect GitHub** button; it asks for the install step too when the app isn't installed yet.
- **The project's repository on GitHub.** Without one, the view says so, and checks again every minute.
- **New permissions approved once.** The app's GitHub permissions now include reading Actions and Deployments. GitHub asks you to approve them once: open https://github.com/settings/installations, choose the Vibe Teamlead app and accept the request. When access is missing, the view shows a **Manage access on GitHub** button next to its message.

## When something is wrong

- **The app can't read the repository's Actions:** the permissions above aren't approved yet, or the app has no access to this repository. **Manage access on GitHub** opens the page to fix it.
- **GitHub can't find this repository:** the repository is private and the app has no access to it, or it no longer exists. When the app isn't installed on the repository's owner, **Install the app on GitHub** opens the install page; otherwise **Manage access on GitHub** lets you add the repository to the app (https://github.com/settings/installations → the Vibe Teamlead app → add the repository).
- **GitHub's rate limit is reached:** the view pauses until the time it shows and continues by itself.
- **GitHub isn't responding:** the view says so and tries again. A log that didn't load is asked for again too.

## Vercel account

Settings → Vercel connects the Vercel account Deploy uses to set up hosting. **Connect Vercel** downloads the Vercel CLI the first time (about 180 MB, checked before use; a download that gets no data for a minute is stopped), shows a code and opens Vercel's sign-in page in your browser; confirm the code there. **Cancel** stops the sign-in and nothing is saved. The sign-in stays in the app's own folder, not in your own Vercel CLI, and is renewed by itself. You can paste a Vercel token instead; it is stored encrypted on this Mac and is used in place of the browser sign-in. If this Mac can't encrypt it, the token is not saved (never as plain text): sign in in the browser instead. With a pasted token nothing is downloaded until you first click **Add database**, which then downloads the Vercel CLI with its progress and a **Cancel** button. **Disconnect** removes both from this Mac (it does not revoke anything on Vercel).

## Readiness

The **Readiness** tab (between Runs and Environment) shows what stands between the project and a first deploy.

**When it scans.** The scan runs the first time Deploy opens for a project with no saved result, after a merge into main for a project that has one, and on **Check again**. It is a model call, so it costs tokens. The scan reads code and example env files, never the values in `.env` files or keys. Its model is **Deploy readiness** in Settings → Agent Settings → feature models (default Sonnet, low thinking).

**Blockers become tasks.** Each blocker in the code or in the CI workflow gets its own task. The tasks go into the **Queue** and start by themselves as the project's parallel-task limit allows, like any queued task (queued tasks start while the task board is open). After QA, a task merges by itself, even when the project's auto-merge is off. This applies only to tasks Deploy itself created. A new check doesn't duplicate a task that is still open: the scan is told the blockers it already knows and keeps their names, and a blocker it describes in other words (the same title, or mostly the same words) stays the same blocker. While its task is open, a blocker the scan doesn't name this time keeps its task and its count. The title opens the task, and the blocker turns done when the task is. A workflow blocker and a failed run on main never get a task at the same time.

**The workflow.** The GitHub Actions workflow is written for this project. It installs on a clean runner what the checks need: browsers for Playwright and for unit tests in browser mode, services, the package manager. Task branches run typecheck and unit tests; main runs everything; Vercel deploys. After the workflow lands on main, the app follows its first run like any run on main, and a failure becomes a fix task.

**After a push to main.** The app follows that commit's runs for up to an hour. The newest failed run of a workflow on main becomes one urgent fix task, with the logs of the failed jobs. While that task is open there is no second one. Runs from forks and pull requests are ignored.

**Giving up.** When a blocker or a failing workflow has been fixed twice and comes back, there is no third task: it moves to **Needed from you** (with a link to the run), and you look at it yourself. Once the workflow passes or the scan no longer finds the blocker, the count starts again.

**What Vercel can't run.** Redis (Upstash) and Blob are added from Environment → Services. Kafka, queue consumers and always-running workers are listed as parts Vercel can't run, without a task.

**Needed from you** lists what only you can do. Environment variables the deployed app needs and that aren't in the project yet (third-party keys and the app's own settings and secrets alike) are listed here one by one; they never become tasks, since an agent can't know the values. Values go into the Vercel project, so before deploy is set up each variable says to set up deploy first. Missing variables don't hold setup back. Once deploy is set up, each one has **Add value**, a variable disappears as soon as Vercel has it, and a notice at the top of the tab says how many values the deployed app still needs before it works. **CI** shows the workflow and the last run on main. The number on the tab is how many blockers the last check found (parts Vercel can't run are not counted); it updates when the check runs again, for example after merges.

**Nothing blocks.** When the last blocker is fixed, deploy is set up by itself. The exception is a Vercel account with teams where none was chosen for the project yet: choose one on the Environment tab first.

## Previews

A task's preview is the Vercel build of its own branch, shown on the task's card and in its window.

**When branches are pushed.** After each finished subtask, after each round of QA fixes and when the task goes to review, the app pushes the task's branch to GitHub with the Vibe Teamlead GitHub App's token, so Vercel builds it. A branch GitHub already has is not pushed again. It does this only when deploy is set up for the project, the repository is private (a repository whose visibility is unknown counts as not private), and **Automatically Push New Branches** is on for both the project and the task. The push is never forced. A refused push doesn't stop the agent: the task window says why, and the last preview stays. Previews are remembered when the app restarts.

**What the card shows.** Only while the task is in progress, in AI review, in human review or in error:

- **Deploy not set up:** nothing on the card. The task window has a line saying so, with **Set up deploy**.
- **Branch not pushed yet:** nothing.
- **Building:** **Preview** with a spinner. It opens the previous link, if there is one.
- **Ready:** **Preview ↗**, opening the link (https only). Hover to see the address and when it was built.
- **Failed:** **Preview failed**. It opens Vercel's build log. When a GitHub Actions check of that commit failed, it opens Deploy → Runs on that run instead, at the log of the job that failed.

The task window says the same: the link, **Building the preview…** (with the previous link, if there is one), or **The preview failed** with the build log or the failed run.

For a public repository the task window says previews need a private repository, and no task branch is pushed at all, not even when the task starts. The app checks again, at most once an hour, that the repository is still private; when it is no longer private, pushes stop.

**Where the state comes from.** From GitHub Deployments for the task branch, the same source as the Deploy tab. While a build is running it refreshes every 30 seconds, and again whenever the branch is pushed. A ready or failed preview is not asked for again until the next push.

**Sign-in.** Vercel protects previews by default: open the link while signed in to Vercel.

**Previews and secrets.** Vercel builds previews from the agents' code with the Preview environment's variables. Keep sensitive keys (for example live payment keys) in Production only, or use separate test values for Preview.

## Environment: set up deploy

Deploy has three tabs: **Runs**, **Readiness** and **Environment**. Until deploy is set up for the project, Runs and Environment offer **Set up deploy**.

Setup, on the Environment tab, goes step by step and shows each one: the GitHub repository (a private one is created when the project has none, and the main branch is pushed to it), the Vercel project linked to that repository, then deploy is on: Vercel deploys to production on every push to main. When a Vercel project is already linked to this repository, choose it or create a new one. If your Vercel account has teams, choose first whether the project goes to your personal account or to a team. A step that stopped can be run again with **Try again**; nothing is created twice.

Vercel deploys a commit only when it can tie the commit's author to your GitHub account. If the project's git has no email set (git then signs commits as `you@your-mac.local`), setup sets your GitHub noreply address (`<id>+<login>@users.noreply.github.com`) for this project only. An address you set yourself is kept.

**Needed from you** lists what only you can do, each with its button: connect Vercel (opens Settings → Vercel) or connect GitHub (opens the GitHub sign-in dialog), install the Vibe Teamlead app or give Vercel's GitHub app access to the repository (opens GitHub), choose an existing Vercel project for the repository or create a new one, or note that the repository is public.

Once set up, the tab shows what exists: the repository and whether it is public, the Vercel project, the production address and the database. From then on, main is pushed to GitHub after every merge into the project's main branch, and Vercel deploys it; the last push and whether it worked show at the top of the tab (for pushes since the app was opened). When GitHub's main has commits this Mac doesn't have, the push is refused: pull them into the project, and the next merge pushes.

A project whose git configuration is unusual (for example, `origin` defined through an include) is not changed: setup stops and explains what it found, so nothing is overwritten.

## Variables and database

**Add variable** saves a variable to the Vercel project for Production, Preview or both, and, if you tick it, as a GitHub Actions secret too. The value is typed into a password field and never shown again; the list shows names only, where they apply and whether they are also in GitHub. When one side saves and the other fails, the dialog says which.

**Add database** adds a free Postgres database (Neon) to the Vercel project. The first time, Vercel asks you to accept Neon's Marketplace terms: the tab shows the policy links with the site each one opens, and nothing is accepted until you click **Accept and add database**. If Vercel needs a step only its dashboard can do, the tab links there. With a pasted token, the first **Add database** downloads the Vercel CLI first (progress and **Cancel** show on the tab).

**Services.** When the readiness check finds that the project needs Redis or Blob, the **Services** section of the Environment tab lists them, each with **Add**. Redis comes from the Vercel Marketplace (Upstash) and Blob is Vercel's own file storage; both go through the same steps as the database: Marketplace terms (for Redis) are shown first and accepted only when you click Accept, the CLI download shows progress with **Cancel**, and their variables go to Production and Preview. Services Vercel can't provide are listed with the reason.

**Preview deployments and the database.** The database's variables go to Production and Preview, so preview deployments may use the same database as production, and what a preview writes lands in your production data. That is not the case when the Neon integration's preview branching is on: then each preview gets its own copy (a database branch). To check, open Vercel → **Storage** → the database → its settings, and see whether preview deployments get their own database branch; turn it on there if you want previews kept apart.
