## WEB BROWSER VALIDATION

For web frontends, validate the running app in a real browser with the bundled **Playwright MCP** tools (`mcp__playwright__*`). The browser is headless with an in-memory profile, so nothing you do touches the user's own browser data.

Work from the accessibility snapshot, not from CSS selectors: `browser_snapshot` returns the page as a tree where every interactive element has a `ref`. Click, type and select by that `ref`.

### Core tools

| Tool | Purpose |
|------|---------|
| `mcp__playwright__browser_navigate` | Open a URL |
| `mcp__playwright__browser_snapshot` | Accessibility snapshot with element `ref`s (use before every interaction) |
| `mcp__playwright__browser_click` | Click an element by `ref` |
| `mcp__playwright__browser_type` | Type into a field |
| `mcp__playwright__browser_fill_form` | Fill several fields at once |
| `mcp__playwright__browser_select_option` | Choose a dropdown option |
| `mcp__playwright__browser_wait_for` | Wait for text to appear or disappear |
| `mcp__playwright__browser_verify_text_visible` | Assert visible text |
| `mcp__playwright__browser_take_screenshot` | Screenshot for visual review |
| `mcp__playwright__browser_console_messages` | Console errors and warnings |
| `mcp__playwright__browser_network_requests` | Failed or unexpected requests |

### Validation flow

1. **Start the app.** Use the dev-server command from PROJECT CAPABILITIES and wait until it answers.
2. **Open the page** with `browser_navigate` (for example `http://localhost:3000`).
3. **Walk each acceptance criterion as a user would.** For every `AC-n` that has UI behaviour: take a `browser_snapshot`, perform the Given/When steps with `browser_click` / `browser_type` / `browser_fill_form`, then check the Then with `browser_verify_text_visible` or a fresh snapshot.
4. **Check health.** After each flow read `browser_console_messages` (errors are findings) and `browser_network_requests` (4xx/5xx responses are findings).
5. **Look at it.** `browser_take_screenshot` for each changed screen; check layout, overflow, empty and error states.
6. **Close** the browser with `browser_close` when done.

Screenshots without an explicit file name are saved to `qa-browser/` in the spec directory, where the user can see them.

### Chrome DevTools (QA fixer)

When `mcp__chrome-devtools__*` tools are available, use them to find the cause of a failure before changing code: console messages with stack traces, the full request and response of a failing network call, and performance traces for slow pages. Reproduce the failure, read the evidence, then fix with a failing test first.

### Document findings

```
BROWSER VERIFICATION:
- AC-n [page/flow]: PASS/FAIL
  - Console errors: [list or "None"]
  - Failed requests: [list or "None"]
  - Visual check: PASS/FAIL (screenshot: qa-browser/<file>.png)
```

### Handling common issues

**Dev server not running:** start it with the project's dev command and wait for it to be ready. If it cannot be started:
- **Specs with UI changes:** this is a critical blocking issue. Mark the review **REJECTED**; visual verification is mandatory for UI changes.
- **Non-UI changes:** write "Browser validation skipped: no UI files changed" and continue with code-based review.

**Chrome not installed:** the browser tools need Google Chrome. If they fail to launch, report it in the QA report and continue with code-based review; do not try to install a browser.
