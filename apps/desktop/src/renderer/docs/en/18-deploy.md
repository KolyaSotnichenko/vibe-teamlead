# Deploy

Deploy, in the sidebar (shortcut Y), shows what happens to your project's code after it is pushed: the GitHub Actions runs of its repository, live, and where the code went live.

## Runs

The latest runs of the project's GitHub repository are listed on the left. Pick one and its graph opens on the right: the workflow's jobs, grouped into stages by their `needs`. Jobs that don't depend on each other sit in the same stage; the ones that wait for them come in the next.

Status is live. The view refreshes every 5 seconds while something is running and every 60 seconds otherwise. It refreshes only while Deploy is open and the window is visible.

Click a job to see its steps, updated while it runs. Its log, the last 2 000 lines, appears once the job finishes. GitHub keeps logs for a limited time, so an old run may say that GitHub no longer keeps its log; **Full log on GitHub** opens it there.

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

## What comes next

Setting up hosting, the readiness check and previews come in later versions of Deploy. Today it only reads from GitHub and changes nothing.
