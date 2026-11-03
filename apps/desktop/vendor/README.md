# Vendored components

Shipped inside the Vibe Teamlead app so users don't have to install anything.

| Component | Source | Version | License |
|-----------|--------|---------|---------|
| `superpowers/` | https://github.com/obra/superpowers @ `2ce8aa1` | 7.0.1 | MIT (see `superpowers/LICENSE`) |

Only the Claude Code plugin parts are kept: `.claude-plugin/`, `hooks/`, `skills/`, `LICENSE`, `README.md`, `package.json`.

To update: clone the upstream repo at the new tag, copy the same paths over, update this table.

CodeGraph is not vendored here — it comes from npm (`@colbymchenry/codegraph-<platform>-<arch>`, MIT) and is copied into the app's resources at packaging time.
