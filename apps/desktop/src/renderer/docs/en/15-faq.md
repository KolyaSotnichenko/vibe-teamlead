# FAQ and troubleshooting

## A task won't start: "No Claude credentials configured"

There is no key for the selected access mode. Open Settings → Claude:
- in API key mode you need a key (and a base URL if it's a gateway);
- in Claude subscription mode you need a token from `claude setup-token`.

The app does not substitute the key from the other mode.

## "There's an issue with the selected model"

A phase or feature model is not served by your endpoint. For example, Ollama models were left over after switching to the subscription, or the other way around. Check Settings → Agent Settings: phase models and feature models. The model list comes from your endpoint; the refresh button is next to the list.

## Tasks sit in Queue and don't get picked up

The queue starts tasks when there is a free slot within the limit on parallel tasks. If all slots are taken by tasks In Progress, new ones wait. A task that depends on another one (for example, from a spec document) waits until that one finishes.

## An agent is "stuck" on a question

The "… is asking" panel on the right: the agent is waiting for your answer. If you closed the panel, open it again through Waiting for you at the top of the sidebar. Skip lets the agent decide on its own, and it records its assumption.

## How to stop a task

The Stop button in the task window. If a plan already exists, the task moves to your review (Human Review); if not, back to Planning. You can continue with the Start button.

## Strix puts a heavy load on the CPU

While the pentest runs, the Strix Docker container is busy. This is normal; the container is cleaned up after it finishes. You can follow progress in the review phase logs (there is a heartbeat once a minute). You can turn Strix off in Settings → Agent Settings.

## A folder is left in Worktrees after merging

If the task folder couldn't be fully deleted, it is marked as orphaned in Worktrees. You can't merge it or create a PR from it, only delete it with the Delete button. If deletion fails, the app shows an error.

## After merge the coding logs and the Security tab are empty

While a task builds, the agents write their logs, QA report, security results and architecture into the task folder's copy inside the worktree. Before a worktree is removed (merge, discard) the app now copies them back into the project. Tasks merged before this fix lost that data with their worktree; it can't be recovered.

## A task in Human Review with "Has Errors"

QA couldn't approve the task and, after the fixer's attempts, handed it to you. The Review tab opens with a "Why QA didn't approve" panel. It gives the reason in plain words and lists what blocked approval, grouped by source: security gates, the design check, or the reviewer's issues. The task pipeline marks QA as the failed stage, not Code.

- A design finding the design system should allow (say, a `repeating-linear-gradient` it uses on purpose) has an "Allow" button. It adds the pattern to `tokens.allowedPatterns`, so the design check stops flagging it. Banned patterns can't be allowed this way.
- "Run QA again" re-runs the fixer and QA.
- To have something specific fixed, describe it in "Request Changes". You can also merge as is.

A run cut off before any code was written has nothing to review, so the task window offers "Resume" instead: coding starts from the plan already written.

These actions don't touch your project's uncommitted files. While a merge of the task waits for your confirmation, commit or cancel it first.

Tasks that failed before this panel existed show a short note and the "Run QA again" button. The details are still in Workspace → Security and in `qa_report.md`.

## Storybook opens without styles

Stories render without the app's look when `.storybook/preview` doesn't import the global styles (`globals.css` and the like), fonts and providers. Agents are now told to set this up, and QA counts unstyled stories as an issue. For a task built before that, use "Request Changes": "import the global styles and fonts in .storybook/preview".

## The Create PR button is disabled

A PR needs a GitHub remote (`origin`). Add it in the project (`git remote add origin …`) or connect GitHub in Settings → GitHub. Merging into the main branch works without it.

## Acceptance criteria are "not verified" after QA

QA writes the AC table to `qa_report.md`. If the model didn't fill in the table in the expected format, Workspace doesn't see the results. Rerunning QA (or using a stronger model for QA) usually fixes this.

## Agents don't use CodeGraph

The task logs should contain the line "CodeGraph: index ready / attached". Agents are told to search through CodeGraph first, but weaker models sometimes still go to grep. If the line is missing, check Settings → Tools.

## Closing the app while agents work

Closing the window quits the app, and nothing keeps working in the background. Quitting stops the agents, so while a task runs the app asks first: keep working, or close and stop. A stopped task can be resumed later.

## Memory is empty

Memory appears after the first subtask completed by the coder. Check that it's enabled in Settings → Memory. To view it: Context → Memories.

## Architecture diagrams don't show

The architect renders each diagram to a PNG next to the file. If there is no PNG (rendering failed), the tab shows the path instead of the image. You can open the `.drawio` file in draw.io with the button on the diagram card.

## QA blocks a task because of design

Design check findings are in `design_check.md` in the task folder. If it's a false positive, add the value to the design system tokens or switch the mode to Report only (Context → Design system).

## Where the diagnostic logs are

Settings → Debug & Logs. Logs for a single task are in the Logs tab of the task window.

## Report a problem

The Report a problem button at the top of this page opens the repository's issues.

## "Noted: … process was stopped by the background timeout" in the logs

An agent started a dev server in the background and didn't close its background task when it finished. That task kept the session open until it timed out, and the agent was woken up again just to acknowledge it. Nothing was broken, but the session ended later and spent an extra turn. Agents now stop their background commands with TaskStop before reporting, so these lines shouldn't appear in new runs.

## "Noted: the dev-server process … was stopped by the background timeout"

Agents start dev servers and watchers as background tasks (QA does this to test the API or the UI). A task left running keeps the session open, and when it times out the agent wakes up for one more turn just to say so. That's harmless but costs tokens. Agents are told to stop every background task with TaskStop before finishing. The app also checks: if an agent tries to finish while tasks it started are still running, it is asked once to stop them first.

## "No such tool available: mcp__playwright__…"

QA gets browser tools only for a web frontend (Playwright) or an Electron app with Electron MCP turned on. For an API or a library there are none. QA's instructions now say which browser tools the session has (or that there are none, and why), so it doesn't try a tool that isn't there, and a browser server that can't start is left out of the session (the task log says so); without browser tools it checks behaviour with tests, `curl` and the code and says in the report that visual checks weren't possible. If your project has a web UI and QA still reports no browser tools, check Settings → Tools and that Chrome is installed.
