# Quality and security

| Layer | What it does |
|---|---|
| **TDD + AC** | Every requirement has a test; QA checks that the test actually holds it. |
| **App checks** | The app itself runs the project's typecheck and tests on a clean copy of what is committed, before each QA review and after a merge, and reads the real exit codes. A failure blocks approval only if the same check passes on the commit the task started from. It also blocks a deleted test file, a test switched off and a changed `test` or `typecheck` script. If a check can't say anything (it fails on the base too, its tool isn't installed), the task isn't blocked and the log says it wasn't verified. Commands are detected for npm, pnpm, yarn, bun, Python, Go, Rust, Maven, Gradle, .NET, Ruby, PHP and Swift at the project's root; others go in the project's settings, with any variables such as a test database. These checks run the task's own code with your permissions, without API keys in their environment, and not in a sandbox. |
| **gitleaks** | Secrets in the code block approval. |
| **OSV-Scanner** | Vulnerable dependencies block approval. |
| **Semgrep** | Static analysis of the changed files (injection, unsafe APIs; its registry rules at ERROR severity) blocks approval. Runs only when Semgrep is installed (`brew install semgrep` or `pip install semgrep`); otherwise, or when its rules can't be fetched, the gate is skipped and the report says so. When Semgrep could not parse some of the files, or reported an error about the run itself, the report says "CLEAR (PARTIAL: …)" and the Security tab names what was not covered, so you can look at those files yourself; if it could not scan any of the files, the gate counts as failed. |
| **Design check** | A static check of added UI lines against the design system tokens + a screenshot review (see "Design system and Storybook"). |
| **Browser check** | QA opens the app in Chrome (Playwright / DevTools MCP), takes screenshots and reads the console. |
| **Strix** | Pentest in Docker (optional). |
| **Security hooks** | Path boundaries, a list of forbidden commands (everything else is allowed), a ban on killing the app's own processes. |
| **Environment isolation** | Agents run with their own Claude Code configuration (`~/.vibe-teamlead/claude-code`), not your `~/.claude`. Environment variables are filtered. |

The scanners (gitleaks, OSV-Scanner), Claude Code, CodeGraph, Superpowers and Mermaid ship with the app, so you don't need to install anything separately. Semgrep is not bundled (it is a Python package): install it if you want that gate. Docker and Chrome are needed only for Strix and browser checks. The status of all tools is shown in Settings → Tools.
