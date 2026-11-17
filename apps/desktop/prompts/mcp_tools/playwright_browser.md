## Web browser validation

The `mcp__playwright__*` tools drive a real browser against the running app. It is headless with an in-memory profile, so nothing you do touches the user's own browser data.

- Start the app with `mcp__vibe-teamlead__start_dev_server` and open the URL it returns with `mcp__playwright__browser_navigate`. The other tools below have the same `mcp__playwright__` prefix.
- Work from the accessibility snapshot, not from CSS selectors: `browser_snapshot` returns the page as a tree where every interactive element has a `ref`. Take one before you interact, and click, type and select by that `ref`.
- Walk each acceptance criterion that has UI behaviour as a user would: do its Given/When steps with `browser_click`, `browser_type` or `browser_fill_form`, then check the Then with `browser_verify_text_visible` or a fresh snapshot.
- After each flow read `browser_console_messages` and `browser_network_requests`: console errors and 4xx/5xx responses on a changed screen are findings.
- Take a screenshot of each changed screen with `browser_take_screenshot` and look at layout, overflow, and the empty and error states. Screenshots without an explicit file name are saved to `qa-browser/` in the spec directory, where the user can see them.
- Close the browser with `browser_close` when you are done.

If the browser fails to launch, Google Chrome is probably not installed. Don't try to install a browser: say in the report that the visual check was not possible, and verify with the project's own end-to-end tests and HTTP checks instead.

### Chrome DevTools (QA fixer)

When `mcp__chrome-devtools__*` tools are available, use them to find the cause of a failure before changing code: console messages with stack traces, the full request and response of a failing network call, and performance traces for slow pages. Reproduce the failure, read the evidence, then fix with a failing test first.
