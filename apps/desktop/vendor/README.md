# Vendored components

Shipped inside the Vibe Teamlead app so users don't have to install anything.

| Component | Source | Version | License |
|-----------|--------|---------|---------|
| `superpowers/` | https://github.com/obra/superpowers @ `2ce8aa1` | 7.0.1 | MIT (see `superpowers/LICENSE`) |
| `drawio/` | https://github.com/jgraph/drawio-mcp @ `2a0f570` | — | Apache-2.0 (see `drawio/LICENSE`) |
| `drawio-viewer/` | https://github.com/jgraph/drawio @ `3e707fd` (`viewer-static.min.js`) | — | Apache-2.0 (see `drawio-viewer/LICENSE`) |
| `vibe-teamlead-skills/` | this repo | — | AGPL-3.0 (same as the app) |

Only the Claude Code plugin parts are kept: `.claude-plugin/`, `hooks/`, `skills/`, `LICENSE`, `README.md`, `package.json`.

For `drawio/` only the skill plugin is kept; the app loads it with MCP discovery off, so diagrams never go to draw.io's cloud. `drawio-viewer/` renders `.drawio` files to PNG offline (main process, hidden window) for the architect's review loop and the task workspace.

To update: clone the upstream repo at the new tag, copy the same paths over, update this table.

CodeGraph is not vendored here — it comes from npm (`@colbymchenry/codegraph-<platform>-<arch>`, MIT) and is copied into the app's resources at packaging time.
