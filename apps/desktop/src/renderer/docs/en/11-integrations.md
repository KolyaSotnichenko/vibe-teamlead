# Integrations

| Integration | What it gives you |
|---|---|
| **GitHub** (Settings → Project → GitHub) | Sign in with GitHub (the Vibe Teamlead GitHub App); the repository is filled from `origin`. Gives you issues → tasks, PRs and PR review (see "GitHub" below). |
| **GitHub Actions** | CI in the sidebar: the project's runs live, what keeps CI from passing, secrets. The app pushes main (and private task branches) with the GitHub App's token (see "CI"). |
| **GitLab** | The same for GitLab: issues and merge requests. |
| **Linear** | Task sync and Linear MCP for agents. |
| **Telegram** | Your own bot on the phone: answer questions, review and merge, approve designs, add tasks, stop the team (see "Telegram"). |
| **draw.io** | Architecture diagrams open in draw.io with one button. |
| **IDE / terminal** | Open a worktree in your editor or terminal (Settings → Developer Tools). |

## GitHub

### Signing in and giving access

- Sign in with GitHub (the Vibe Teamlead GitHub App) and the repository is filled from `origin`.
- Signing in and giving the app access are two steps.
- After signing in, install the app on GitHub (**Install the app on GitHub**) and choose all repositories or only some.
- Without it the app can't see private repositories, and the setup dialog says so with a button to fix it.

### Adding a repository later

- Open https://github.com/settings/installations.
- Choose the Vibe Teamlead app and add the repository.
- Then press **Check again**.

### Personal access token

- A personal access token is only needed when the App isn't installed on the repository's account or organisation, or to act as another account.

### What it gives you

- Issues → tasks, PRs, PR review.
- The base branch and "push new branches" are available even without connecting GitHub.
