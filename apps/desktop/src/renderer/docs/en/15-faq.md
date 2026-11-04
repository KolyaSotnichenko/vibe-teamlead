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

## The Create PR button is disabled

A PR needs a GitHub remote (`origin`). Add it in the project (`git remote add origin …`) or connect GitHub in Settings → GitHub. Merging into the main branch works without it.

## Acceptance criteria are "not verified" after QA

QA writes the AC table to `qa_report.md`. If the model didn't fill in the table in the expected format, Workspace doesn't see the results. Rerunning QA (or using a stronger model for QA) usually fixes this.

## Agents don't use CodeGraph

The task logs should contain the line "CodeGraph: index ready / attached". Agents are told to search through CodeGraph first, but weaker models sometimes still go to grep. If the line is missing, check Settings → Tools.

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
