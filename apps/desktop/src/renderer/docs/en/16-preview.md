# Preview

Preview, in the sidebar, runs your project's app from the main branch inside the window, so you can see what the agents built without starting anything yourself.

## When it runs

It starts when you open Preview and stops when you leave it: another sidebar item, another project, or quitting the app. Nothing keeps running in the background, and only one preview runs at a time. Coming back starts it again.

While it is open, a merge into main moves it to the new code. Pages reload as they would in development. When the merge changed the dependencies, the app installs them and restarts the services.

## The first time

The app reads the project's `dev` scripts and proposes what to run, for example `api` and `web` in a monorepo. Check the list once:

- **Folder:** where the command runs, relative to the project.
- **Command:** the command itself. `{port}` becomes the port the app picked; the port is also in `PORT`.
- **Page:** the service whose page the preview shows. Exactly one.
- **Variables with another service's URL:** for example `NEXT_PUBLIC_API_URL=api` gives the page the address of the `api` service.

Change the list later with **Services** in the toolbar. The list is kept in the project's settings in the app, not in the repository.

## Where its code and data come from

- **The code** is a copy of main of its own, in `~/.vibe-teamlead/worktrees/preview`, outside your project. Your own folder, its branch and its uncommitted changes are never touched.
- **The database** named in the project's compose file runs in Docker on a volume kept for this project, so an account you registered in the preview is still there next time. Migrations are applied to it, and on a new, empty database the project's seed script runs (`db:seed`, `seed`, or Prisma's seed). **Reset preview data** deletes it and starts empty.
- **Settings** come from `.env.example` and the preview's own database, never from `.env`. Your real databases and keys are not used.

Without Docker, the services still start, without a database, and the preview says so.

## The page

The page runs in a view of its own, separate from the app: no access to your files, and its cookies are kept apart. It stays on its own address; links to other sites open in your browser. The toolbar has back, forward, reload, the address, and widths of 375, 768 and 1280 pixels or the full window.

## When it does not start

The preview names the service that didn't start and shows the end of its log. The ones that already started are stopped. Fix the command under **Services** and open Preview again.
