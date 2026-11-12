Workflow rules (fixed):

- Write the GitHub Actions workflow for this project.
- Install every tool the checks need on a clean ubuntu runner. Name each of these explicitly:
  - browsers for Playwright e2e tests and for browser-mode unit tests (for example `playwright install --with-deps chromium`, run before the unit tests when they use a browser);
  - the database and other services the checks use, as service containers;
  - the package manager setup (for example pnpm through its setup action or corepack).
- Task branches (pull requests and pushes to any branch other than main) run typecheck and unit tests, including browser-mode unit tests.
- Main runs everything, e2e tests included.
- Never run `vercel deploy`: Vercel's Git integration deploys.
- Secrets come from `${{ secrets.NAME }}` and are never written in the file.
- Validate the YAML before committing.
