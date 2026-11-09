# Preview

Preview, in the sidebar, runs your project's app from the main branch inside the window, so you can see what the agents built without starting anything yourself.

## When it runs

It starts when you open Preview and stops when you leave it: another sidebar item, another project, or quitting the app. Nothing keeps running in the background, and only one preview runs at a time. Coming back starts it again.

While it is open, a merge into main moves it to the new code. Pages reload as they would in development. When the merge changed the dependencies, the app installs them and restarts the services.

## The first time

The app reads the project's files and proposes what to run, for example `api` and `web` in a monorepo:

- **JavaScript and TypeScript:** each package's `dev` (or `start:dev`) script; Next, Vite, Nuxt, SvelteKit, Astro, Angular and Remix frontends become pages.
- **Python:** Django (`manage.py runserver`), FastAPI (`uvicorn`, with the module that creates the app) and Flask (`flask run`), run through uv or Poetry when the project uses them, otherwise a `.venv` of the preview's own.
- **Ruby:** Rails (`bin/rails server`). **PHP:** Laravel (`php artisan serve`). **Go:** `go run` of the main package, at the root or under `cmd/`.

Anything else that serves HTTP works too: add it under **Services** with a command that takes `{port}` or reads `PORT`. Check the list once:

- **Folder:** where the command runs, relative to the project.
- **Command:** the command itself. `{port}` becomes the port the app picked; the port is also in `PORT`.
- **Page:** the service whose page the preview shows. Exactly one.
- **Variables with another service's URL:** usually none. A local address in `.env.example`, such as `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001`, is pointed at the preview's own port for the service that listens on 3001 in the project: the port from its `.env.example`, its `dev` script, or its framework's default. Name one here only when that can't be worked out, for example `NEXT_PUBLIC_API_URL=api`.

Change the list later with **Services** in the toolbar. The list is kept in the project's settings in the app, not in the repository.

## Where its code and data come from

- **The code** is a copy of main of its own, in `~/.vibe-teamlead/worktrees/preview`, outside your project. Your own folder, its branch and its uncommitted changes are never touched.
- **The database** named in the project's compose file runs in Docker on a volume kept for this project, so an account you registered in the preview is still there next time. Migrations are applied to it (Prisma, Drizzle, Django, Alembic, Rails, Laravel), and on a new, empty database the project's seed script runs (`db:seed`, `seed`, or Prisma's seed). A Django, Rails or Laravel app with no database in compose gets its migrations on its own local file. **Reset preview data** deletes it and starts empty.
- **Dependencies** are installed with the project's own tool: pnpm, npm, yarn or bun; uv, Poetry or pip; Bundler; Composer; Go modules. A folder is installed again only when its lockfile changes. The tool itself (Python, Ruby, PHP, Go) has to be on your Mac; when it isn't, the preview says which install failed and shows its output.
- **Settings** come from `.env.example` and the preview's own database, never from `.env`. Your real databases and keys are not used.

Without Docker, the services still start, without a database, and the preview says so.

## The page

It opens the project's home page, `/`. When that page is still a placeholder, type the path you want in the address field, for example `/login`.

The page runs in a view of its own, separate from the app: no access to your files, and its cookies are kept apart. It stays on its own address; links to other sites open in your browser. The toolbar has back, forward, reload, the address, and widths of 375, 768 and 1280 pixels or the full window.

## When it does not start

The preview names the service that didn't start and shows the end of its log. The ones that already started are stopped. Fix the command under **Services** and open Preview again.
