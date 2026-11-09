---
name: ux-review
description: Live UX review of the pages a task changed, in a real browser. Use as the QA reviewer of a task that changed UI files, after the acceptance criteria are checked.
---

# UX review

You check the pages this task changed the way a person will use them: in the running app, not only in the code. Each problem is a finding in `qa_report.md` with the page, the width, what happens, what should happen, and the file to fix. You don't fix anything.

## What comes first

1. **The project's design system** (`.vibe-teamlead/design-system.md` and its tokens, when present) and **the spec**. Where they decide something (colours, type, spacing, radii, components, copy), they win over every checklist below.
2. The checklists here are for what they leave open. Use them as lists of things to look for. Ignore their own output formats, scores and the commands they suggest (`/impeccable …`): those tools are not installed.

## Steps

1. **Which pages.** From the diff, list the routes, screens and components this task added or changed. Review those, and the path to them.
2. **Open the app.** Start it with `mcp__vibe-teamlead__start_dev_server` if it is not running, and open each page with `mcp__playwright__browser_navigate`.
3. **Two widths.** `mcp__playwright__browser_resize` to 1280×800, then to 375×812. At each: take a screenshot into the spec's `qa-browser/` folder (`ux-<page>-<width>.png`) and read the page with `mcp__playwright__browser_snapshot`. Look for overflow and horizontal scroll, cut-off or overlapping text, controls under 44px on phone, a layout that stays desktop-shaped on a phone.
4. **Keyboard.** At 1280, press `Tab` with `mcp__playwright__browser_press_key` through the page: every control is reached in a sensible order, focus is visible, `Enter` and `Space` work, `Escape` closes dialogs and menus, focus does not get lost or trapped.
5. **Theme and motion.** If the design system has a dark theme, `mcp__playwright__browser_emulate_media` with `colorScheme: dark` and look again at 1280: contrast, invisible borders, hard-coded colours. With `reducedMotion: reduce`, nothing important depends on animation.
6. **States.** For what the task changed, see the empty state (no data), the loading state, the error state (a failed request, invalid input) and a long value (a long name or title). Reach them through the app where you can; otherwise read the code for each and say which ones you could not see.
7. **The path.** How a person reaches the page from where they already are (a link, a menu, a redirect after an action) and where an action leaves them. A page reached only by typing its URL is a finding. Text that says it is a placeholder or "coming soon" is a finding.
8. **Console.** `mcp__playwright__browser_console_messages`: errors and failed requests on these pages are findings.
9. **Checklists.** Read [reference/web-interface-guidelines.md](reference/web-interface-guidelines.md) and check the changed files and pages against it. For accessibility, responsiveness and theming, use [reference/impeccable-audit.md](reference/impeccable-audit.md); for empty, error and extreme-input states, [reference/impeccable-harden.md](reference/impeccable-harden.md). Read them once per review, not per page.

## Severity

- **Blocks approval:** a person can't complete what the task is for (can't reach the page, can't operate it by keyboard, broken or unusable at 375, no feedback on an error, content hidden or overlapping), an accessibility failure against WCAG 2.2 AA, a placeholder left in, or a design-system violation.
- **Doesn't block:** polish and taste the design system and spec don't decide. List them under a "UX notes" heading in `qa_report.md`, not as issues.

## When you can't see it

If the app can't start or the browser tools are missing, review the changed UI code against the checklists, and write in the report that the live check was not possible and why. Never approve a UI change as checked live when it wasn't.
