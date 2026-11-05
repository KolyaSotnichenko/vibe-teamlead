# Quality and security

| Layer | What it does |
|---|---|
| **TDD + AC** | Every requirement has a test; QA checks that the test actually holds it. |
| **gitleaks** | Secrets in the code block approval. |
| **OSV-Scanner** | Vulnerable dependencies block approval. |
| **Semgrep** | Static analysis of the changed files (injection, unsafe APIs; its registry rules at ERROR severity) blocks approval. Runs only when Semgrep is installed (`brew install semgrep` or `pip install semgrep`); otherwise, or when its rules can't be fetched, the gate is skipped and the report says so. |
| **Design check** | A static check of added UI lines against the design system tokens + a screenshot review (see "Design system and Storybook"). |
| **Browser check** | QA opens the app in Chrome (Playwright / DevTools MCP), takes screenshots and reads the console. |
| **Strix** | Pentest in Docker (optional). |
| **Security hooks** | Path boundaries, command allowlist, a ban on killing the app's own processes. |
| **Environment isolation** | Agents run with their own Claude Code configuration (`~/.vibe-teamlead/claude-code`), not your `~/.claude`. Environment variables are filtered. |

The scanners (gitleaks, OSV-Scanner), Claude Code, CodeGraph, Superpowers and Mermaid ship with the app, so you don't need to install anything separately. Semgrep is not bundled (it is a Python package): install it if you want that gate. Docker and Chrome are needed only for Strix and browser checks. The status of all tools is shown in Settings → Tools.
