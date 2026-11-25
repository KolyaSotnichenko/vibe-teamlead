# Design before code

For a task that changes the interface, a designer agent draws its screens before anyone plans or writes code: first wireframes, then the screens in the project's design system. You look at them on the task's **Design** tab, comment on a spot or approve, and the coder builds to the approved design. QA compares what was built with it.

## When it runs

Right after the spec, for every task whose spec names a UI file (or names no files in a project with a UI). Tasks that change no UI skip it: the pipeline shows the Design stage as passed. The spec of such a task stops before the architecture and the plan; they come after the design, so the plan follows it.

## The steps

1. **Wireframes.** The structure of every screen and state the acceptance criteria name — phone and desktop widths, empty, loading, error — in grey, with real labels. No colours yet.
2. **Your turn.** The card says *Design: your turn* and the task waits. On the Design tab, turn on **Comment** and click a spot on a frame; write what should change. Add a comment on the whole set if you like. **Send comments** runs one designer session that changes only what you commented on, and the task waits again. **Approve wireframes** goes on.
3. **Design.** The approved wireframes drawn in the design system: its colours, fonts, radii and components. The design check runs on them; places outside the design system get one fixing pass, and any left are shown on the tab.
4. **Your turn again.** Comment, or **Approve design and plan the code**.
5. **Plan and code.** The app lists what a person can use on each screen (buttons, links, fields, tabs, switches; the designer's notes on the prototype left out). The planner gives every one of them to a subtask and names the design files each subtask builds; the coder builds to them at the same widths, with the project's real components and data. Subtasks never ask the coder to check pages in a browser: the coder has none, QA does that.
6. **QA.** The QA reviewer starts the app (with its database and sign-in), opens each frame of the design at its width, takes a screenshot and compares it with the design, looking for every element listed for that screen. The app checks this itself: QA can't approve until every frame has a screenshot taken after the last commit, or a reason it couldn't be shown, and no blocking difference is left. Missing elements, states or layouts block like any QA issue. Then the app looks for itself, without a model: it opens each frame QA showed by QA's recorded steps (`screens.json`) and looks for every element of the mockup on the built page. An element it doesn't find must be named by QA, either as a blocking difference, which rejects the task, or as a minor one that says why it isn't needed (the mockup's sample data, or the same thing under another name), listed for you under **Built vs design**. A frame the app can't open by those steps goes back to QA once to fix them; if it still can't, it counts as a frame QA couldn't show. The same holds when the app can't make this check at all (the task's app doesn't start, or a mockup can't be read): a check that didn't run is not a check that passed. A frame QA couldn't show keeps the task from merging by itself: it waits for you. The notice and the task's window name each such screen, its width and QA's reason, under **Check … screens before merging**: look at them in Workspace → Preview next to their frames on the Design tab (which lists them as **Not seen in the app**), then merge or send the task back. Small differences within the design system are listed for you under **Built vs design**.

Every screen a person can see gets a design and follows the design system, test or dev-only ones included: a local sign-in (one click per role), seed or stub pages, error and empty states. Specs never ask for an "unstyled" screen.

**A task that changes existing screens** (a redesign, a fix to the board) names them from the project's library in its plan: each UI subtask lists the design files it builds to, the library's included. The coder gets those files with what a person can use on each, and QA must show every one of them in the running app, not only the screens the task's own design drew. This holds for a task with no designer too (the short pipeline): its plan names the screens in the library, the app copies the library into the task's `design/base/` before the coder starts, and QA can't approve until each named screen is shown in the running app.

**The project's other screens (screen check).** A task can break a screen it never touched (a shared component, a global style). When QA shows a frame in the running app, it also records how it got there (the path, the clicks and typing, the parts that change on their own such as dates) in `screens.json`. When the task merges, the app adds that to the project's catalog of screens, kept in `~/.vibe-teamlead/screens/` where agents can't write, and takes a picture of every screen in the catalog while its check runs the code that becomes main. Before each later QA review, while the app's check runs the task's code, it takes the same pictures again and compares them pixel by pixel, without a model. Only the screens that changed outside the task go to QA, as before and after pictures; QA marks each as expected (the task meant to change it, with why) or a regression, which it rejects the task with. A screen the app couldn't reach by its recorded steps is listed for QA to record again. The Design tab lists the other screens that changed, with QA's verdict. Web apps only; the catalog fills up as tasks with a design pass QA.

**Sample data.** A screen can be checked only when it has data. Specs ask for the project's seed script to create what the task's screens show (with a test user for each role, used by the one-click test sign-in), and the planner puts the seed in the subtask that adds the data.

## When the designer stops

A UI task is never built without a design unless you say so.

- **A rate limit or a busy API:** the app waits (until the limit resets, when the error says when) and tries the designer again, up to three times and at most an hour of waiting in all. A limit that resets later than that stops the task for you at once. While it waits, the task card and the Design tab say so, for example *Designer is waiting for the rate limit — retrying at 14:05 (attempt 2 of 3)*; **Stop waiting** stops the task for you now.
- **You stop the task:** the design stays where it was; the next start goes on from the same step.
- **Still failing, or another error:** the task stops in Human Review with *Design couldn't be made*. The Design tab shows the designer's error and two buttons: **Try the design again** (starts the design again from where it stopped) and **Build without design** (the coder builds from the spec and the design system; recorded as your decision). Telegram sends a message with the designer's error and the same two buttons; a press is refused if the task no longer waits for this decision, and the message then says what happened.

A design skipped before this (the designer stopped and the task went on) says so on the Design tab, with the reason.

Each screen is one responsive page, shown on the canvas at the widths that matter (phone 390, desktop 1280, tablet 768 when it differs). The designer links the screens like a real flow. On the canvas, point at a frame (or click it) to see arrows from its links to the screens they open, and into it; a frame's title shows how many transitions leave it; **Show all flows** draws the whole map.

**Play prototype** opens the first screen of the flow full size: click through the screens as a person would, **← Back** goes back along them, and 390 / 768 / 1280 resize the page live. Clicking beside a link briefly highlights everything clickable, as in Figma. Animations play too.

## Animations

The designer and the UI coders of a project that animates with GSAP get GreenSock's official GSAP skills (bundled). Motion follows the design and respects reduced motion. The GSAP library itself isn't bundled: a design loads it from one pinned CDN address, and the project gets it as a dependency in the task that builds it.

## The project's design library

When a task's design is done (approved, or gone on by itself), its wireframes and screens go into the project's library; a frame with the same name replaces the older version. The next task's designer starts from the library: a screen it changes is redrawn from its current version, a new one is drawn in the same style. It is given the frames its task needs, at most 20: first the screens the spec names exactly (its routes such as `/plans/:id/board` and its page and component names), then the pages of the files the task will change, then the app shell. Only when nothing is named exactly are screens picked by the spec's words. The rest are in a list it opens only when needed. **Context → Design system → Screens** shows the whole library on one canvas, each frame with the task it came from.

## Settings

Context → Design system → Setup → **Design before code**:
- **Off / Wireframes / Wireframes and design** (default: wireframes and design, for every project).
- **Who approves:** *I approve each step* (default: the task waits for you at each stage) or *Go on by itself* (the designer checks its own frames; you see them on the Design tab and in review).

The designer's model is **Designer** in Settings → Feature models (it inherits the Design system model). Like the phase models, it is taken from the settings at the start of each run, and the task's Logs show it on the Design phase. Cost: two designer sessions per UI task, plus one per round of comments.

## Good to know

- **A task waiting for you holds its slot.** With one task at a time, the queue waits until you approve or comment.
- **Frames are sandboxed.** They are HTML the designer wrote: shown without Node, without access to the app, with no network except Google Fonts and the pinned GSAP, and links leading anywhere else are not followed.
- The design files are in the task's spec folder under `design/`; the library is `.vibe-teamlead/design/library/` in the project.
- **Shared styles, written once.** The pages of a task's wireframes and of its screens share one `styles.css` in their folder: the design system's tokens, the app shell and the components. Each page holds only its own markup, and the designer changes files with small edits instead of rewriting them, so a design costs far fewer tokens. In the library each frame keeps its styles inside it, so a later task's styles never change how an earlier screen looks.
