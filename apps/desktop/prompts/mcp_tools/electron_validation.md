## Electron app validation

The `mcp__electron__*` tools attach to a running Electron app over its remote debugging port, so the app has to run with `--remote-debugging-port=9222`. Many projects have a script that passes the flag (`dev:mcp`, `dev:debug`, `start:mcp`); look in the package scripts.

- `mcp__electron__get_electron_window_info` tells you whether the app is running and which windows it has. Call it first; if it finds no app, start the app and try again.
- `mcp__electron__take_screenshot` captures a window. Take one for each changed screen and look at it.
- `mcp__electron__send_command_to_electron` acts on the page. Its commands:
  - `get_page_structure` — the interactive elements (buttons, inputs, selects, links); use it before you click or fill
  - `click_by_text` with `{"text": "Button Text"}`, `click_by_selector` with `{"selector": "button.submit-btn"}`
  - `fill_input` with `{"selector": "#email", "value": "..."}` or `{"placeholder": "Enter email", "value": "..."}`
  - `send_keyboard_shortcut` with `{"text": "Enter"}` (also `"Ctrl+N"`, `"Meta+N"`, `"Escape"`)
  - `eval` with `{"code": "document.title"}`
- `mcp__electron__read_electron_logs` with `{"logType": "console", "lines": 50}` reads the console. Errors on a changed screen are findings.

Walk each acceptance criterion that has UI behaviour as a user would, then read the console.
