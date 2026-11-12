Workflow rules (fixed):

- Write the GitHub Actions workflow for this project.
- Install every tool the checks need on a clean ubuntu runner, including browsers for browser-mode unit tests and e2e tests.
- Task branches (pull requests and pushes to any branch other than main) run typecheck and unit tests, including browser-mode unit tests.
- Main runs everything, e2e tests included.
- Never run `vercel deploy`: Vercel's Git integration deploys.
- Secrets come from `${{ secrets.NAME }}` and are never written in the file.
- Validate the YAML before committing.
