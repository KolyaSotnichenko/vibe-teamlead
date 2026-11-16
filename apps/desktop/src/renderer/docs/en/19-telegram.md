# Telegram

Answer agents' questions, review and merge tasks, approve designs, add tasks and stop the team from your phone. The app talks to your own Telegram bot, from your computer: there is no server of ours in between. It works the same on macOS and Windows.

## Set it up

1. **Create a bot.** In Telegram, open @BotFather (its mini app works from the phone), send `/newbot`, pick a name and a username ending in `bot`. BotFather gives you a token like `123456789:AA…`.
2. **Paste the token.** Settings → Telegram, paste it into **Bot token** and press **Save**. The app checks it with Telegram first; a token Telegram doesn't accept is not saved. **Test** checks a token without saving it. The token is stored encrypted (Keychain on macOS, DPAPI on Windows), never shown again and never written to the logs. **Remove token** turns the bot off.
3. **Pair.** Press **New code**: the app shows a command like `/start ABCD2345`, valid for 10 minutes. Send it to your bot (or use **Open the bot in Telegram**, which sends it for you). The app records you as the owner and the bot greets you.

Only the owner is served, and only in the private chat with the bot. Messages from anyone else are ignored without a reply. **Unpair** forgets the owner; pair again with a new code.

The status line says whether the bot is connected, and why not when it isn't: a token Telegram no longer accepts (the bot stops; save a new one), another program reading the same bot (close it, or create a separate bot for this app), or Telegram not reachable (the app keeps trying).

## What it sends

Each kind has a switch in Settings → Telegram; all are on by default.

- **An agent asks a question.** The question comes with its options as buttons, the recommended one first and marked ★. **Other…** asks you to type an answer. A question with several choices lets you tick them and press **Done**. When an agent asks several questions at once, they come one after another and go back to the agent together, the same way as an answer in the app (a task made from a brief shares it with the brief's other tasks). If you answer on the computer first, the chat message says "Answered on the computer" and its buttons stop working. An answer to a question that no longer waits is refused.
- **A task waits for your review**: see "Review from the chat" below.
- **A design waits for your approval**: see "Design approval" below. It comes with the review switch.
- **A task failed, got stuck or stopped with an error.**
- **CI failed on main**: a failed GitHub Actions run of the app's own push, with a link to the run.
- **A task was merged.**
- **App checks found a regression**: the merge was stopped because the checks fail with the task's changes, or the checks fail on main itself (the app starts a task to fix main).

## Review from the chat

When a task reaches Human Review, the message tells whether QA approved it, how many acceptance criteria pass, what the app's own checks found (passed, not verified, or passed with the commands from the task itself when the base had none), how many files changed (+/−), and a link to the diff on GitHub when the task's branch was pushed. A task that changed the UI sends QA's latest browser screenshots first (one photo or an album of up to 10); a task without them sends none.

- **Merge** asks first. **Yes, merge** runs the same merge as the Merge button in the app, with the same rules. Whether the task still waits for review is checked again at that moment. The merge runs in the background; the message ends with the result: merged, "check them on the computer and confirm" (an agent changed files to bring in the latest changes), or failed with the reason and the buttons again.
- **Send back** asks for your instruction (reply to the bot's message). It goes to the team the same way as "send back with an instruction" in the app.
- **Later** removes the buttons; the task waits on the board.

If you handle the task on the computer first, the message says "Handled on the computer" and its buttons stop working.

## Design approval

When the designer's wireframes or screens wait for you (Settings → project → design approval by the owner), they come as an album, then a message with **Approve** and **Comment**. **Approve** approves the stage that waits, as on the Design tab. **Comment** asks for your comment and sends it to the designer as a comment on the whole set. Decided on the computer first: the message says so and its buttons stop working.

## New tasks from the chat

- `/task <text>` creates a task in the current project (`/project`; the only open project when there is one) in Planning, the same way as the New task dialog, with a **Start** button. Start keeps the board's rules: when the project's parallel-task limit is reached, or the queue is paused by `/stop_all`, the task goes to the queue and starts when a slot frees. A short first line becomes the title; otherwise the app writes one, as for an empty title.
- A plain message offers **Create a task**.
- Text longer than about 600 characters also offers **Analyse as a brief**: the brief import runs without asking questions (the open questions are listed instead) and sends back the proposal: epics, tasks and open questions, with **Create N tasks** (in Planning, not queued) or **Discard**. It takes a few minutes and spends Claude tokens, like the brief import in the app.

## Morning digest

Once a day, from the time set in Settings → Telegram (09:00 by default; it can be turned off), the bot sends a digest of the open projects: what merged since the last digest, what waits for you, what runs and is queued, what failed, and the spend since the last digest. If the app is closed or the computer sleeps at that time, it comes when the app starts or wakes the same day. It never comes twice a day.

## Commands

- `/status` — the open projects with their running, queued and waiting tasks, how many questions wait for an answer, and today's spend (from the projects' usage log).
- `/project` — choose the project later commands act on.
- `/task <text>` — a new task in the current project.
- `/stop_all` — asks first; **Yes, stop all** stops every running agent the way Stop does and pauses the queue. While the queue is paused, the board's Queue column says **Paused** with **Resume**, and no queued task starts.
- `/resume` — the queue runs again.
- `/help` — the list of commands.

## When the app is closed

The bot works only while the app is open; nothing runs on a server. Telegram keeps messages for 24 hours. When the app starts again, it reads them, but skips commands and button presses older than 15 minutes (a stale "Stop all" never fires) and tells you what it skipped. Buttons work for 12 hours and stop working when the app restarts.

## Privacy

Bot chats are not end-to-end encrypted: Telegram sees the task titles, questions, summaries and screenshots sent to the chat, and the texts you send to it. No secrets, keys or environment values are ever sent: every message is checked and anything that looks like a key or token is replaced with `[redacted]`.
