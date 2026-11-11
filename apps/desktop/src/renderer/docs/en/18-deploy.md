# Deploy

Deploy, in the sidebar (shortcut Y), shows what happens to your project's code after it is pushed: the GitHub Actions runs of its repository, live, and where the code went live.

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

Settings → Vercel connects the Vercel account Deploy uses to set up hosting. **Connect Vercel** downloads the Vercel CLI the first time (about 180 MB, checked before use), shows a code and opens Vercel's sign-in page in your browser; confirm the code there. **Cancel** stops the sign-in and nothing is saved. The sign-in stays in the app's own folder, not in your own Vercel CLI, and is renewed by itself. You can paste a Vercel token instead; it is stored encrypted on this Mac and is used in place of the browser sign-in. **Disconnect** removes both from this Mac (it does not revoke anything on Vercel).

## Environment: set up deploy

Deploy has two tabs: **Runs** and **Environment**. Until deploy is set up for the project, both offer **Set up deploy**.

Setup, on the Environment tab, goes step by step and shows each one: the GitHub repository (a private one is created when the project has none, and the main branch is pushed to it), the Vercel project linked to that repository, then deploy is on. If your Vercel account has teams, choose first whether the project goes to your personal account or to a team. A step that stopped can be run again with **Try again**; nothing is created twice.

**Needed from you** lists what only you can do, each with its button: connect Vercel or GitHub (opens Settings), install the Vibe Teamlead app or give Vercel's GitHub app access to the repository (opens GitHub), choose an existing Vercel project for the repository or create a new one, or note that the repository is public.

Once set up, the tab shows what exists: the repository and whether it is public, the Vercel project, the production address and the database. From then on, every merge into the project's main branch is pushed to GitHub, and Vercel deploys it; the last push and whether it worked show at the top of the tab.

## Variables and database

**Add variable** saves a variable to the Vercel project for Production, Preview or both, and, if you tick it, as a GitHub Actions secret too. The value is typed into a password field and never shown again; the list shows names only, where they apply and whether they are also in GitHub. When one side saves and the other fails, the dialog says which.

**Add database** adds a free Postgres database (Neon) to the Vercel project. The first time, Vercel asks you to accept Neon's Marketplace terms: the tab shows the policy links with the site each one opens, and nothing is accepted until you click **Accept and add database**. If Vercel needs a step only its dashboard can do, the tab links there.

## What comes next

The readiness check and previews come in later versions of Deploy.
