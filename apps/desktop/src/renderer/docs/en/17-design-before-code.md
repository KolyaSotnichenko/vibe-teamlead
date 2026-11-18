# Design before code

For a task that changes the interface, a designer agent draws its screens before anyone plans or writes code: first wireframes, then the screens in the project's design system. You look at them on the task's **Design** tab, comment on a spot or approve, and the coder builds to the approved design. QA compares what was built with it.

## When it runs

Right after the spec, for every task whose spec names a UI file (or names no files in a project with a UI). Tasks that change no UI skip it: the pipeline shows the Design stage as passed. The spec of such a task stops before the architecture and the plan; they come after the design, so the plan follows it.

## The steps

1. **Wireframes.** The structure of every screen and state the acceptance criteria name — phone and desktop widths, empty, loading, error — in grey, with real labels. No colours yet.
2. **Your turn.** The card says *Design: your turn* and the task waits. On the Design tab, turn on **Comment** and click a spot on a frame; write what should change. Add a comment on the whole set if you like. **Send comments** runs one designer session that changes only what you commented on, and the task waits again. **Approve wireframes** goes on.
3. **Design.** The approved wireframes drawn in the design system: its colours, fonts, radii and components. The design check runs on them; places outside the design system get one fixing pass, and any left are shown on the tab.
4. **Your turn again.** Comment, or **Approve design and plan the code**.
5. **Plan and code.** The planner names the design files each subtask builds; the coder builds to them at the same widths, with the project's real components and data.
6. **QA.** The QA reviewer opens the built pages at each screen's width and compares them with the design (a picture of each approved screen is made for it). Missing elements, states or layouts block like any QA issue; small differences within the design system are listed for you under **Built vs design** on the Design tab.

Every screen a person can see gets a design and follows the design system, test or dev-only ones included: a local sign-in (one click per role), seed or stub pages, error and empty states. Specs never ask for an "unstyled" screen.

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
