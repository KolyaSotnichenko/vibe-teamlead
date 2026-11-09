# Design system and Storybook

**What it is.** The project's document (`design-system.md`) and tokens (`design-tokens.json`):
- a palette with color roles, fonts and a size scale, spacing, radii;
- whether shadows and gradients are allowed;
- components and their states;
- rules for interface text;
- a "never" list (forbidden patterns).

**Where it lives.** In the project's `.vibe-teamlead/`, or in a repository file (`DESIGN-SYSTEM.md` at the root, `design/` or `docs/`), or at a path you specify.

**Three steps.** The tab opens with a strip of three steps; the dark one is what to do next:
1. **References** (optional): sites, screenshots, a brand book you like.
2. **Design system**: the rules and tokens themselves.
3. **Apply to the project**: tasks that bring code written before the system up to it. The step shows how many places in how many files differ (checked without a model each time the tokens change).

**Where to start** (Context → Design system, while there is no system yet), two paths:
- **Path A — "I like how it looks now": Extract from the code.** The agent reads the theme, CSS variables and components and writes down the visual language that already exists;
- **Path B — "I want a new look": Add references, then Design.** You describe the product, audience and mood → the agent proposes three different directions (palette, fonts, principles) → you choose → it writes the full system. If there is code already, step 3 applies it;
- **Point at the file** (under the two paths): use a design system document already in the repository.

**When references come after the system.** The app remembers which references the system was written from. Ones added later are marked **new** (the others **in the system**), and a banner asks for an update: **New direction with the references** (three directions again) or **Only update from "As is" references** (extract again: the code plus the references). Until then the agents see the new references' notes, but the system's colours, fonts and radii stay as they were.

The document and tokens can be edited right in the tab. The model for this agent is "Design system" in the feature models.

**References** (Context → Design system → References): images, PDFs (brand books), token files (W3C / Tokens Studio JSON, CSS variables, a Tailwind config) and sites, as many as you like.
- Each is looked at once when you add it and gets short notes: what it is, its palette, fonts, light or dark, traits and what to take from it. Colours of images and page screenshots are measured from the pixels, not guessed. Token files are read exactly, without a model. A site is opened in a hidden, sandboxed window (no sign-ins, no downloads): screenshot plus what its CSS declares.
- Every reference has a role: **As is** (rules: exact colours, fonts, brand rules) or **Inspiration** (a direction, not a copy). Token files and PDFs start as "As is", images and sites as "Inspiration".
- "Extract", "Design a new one" and "Write" use them: as-is ones are followed, inspiration ones are read for what they share. The agent opens the as-is images and up to 6 inspiration ones itself and knows the rest from their notes, so many references don't overflow it. It ends the document with a "References" section: what it took from which, and the conflicts it resolved.
- The tab shows what the references share and where they disagree (light vs dark, different fonts in as-is ones). Many different inspiration references blur the direction: keep the ones that matter.
- Pipeline agents and QA get the notes too (as-is ones are binding).
- Files are kept in `.vibe-teamlead/design/references/`. Each digest is a small design-agent session, counted in the token usage.

**How agents use it:**
- **Builders** (spec writer, architect, planner, coder, QA fixer) get the design system and the "anti-slop" rules in their prompt.
- **UI projects without a design system** still get the "anti-slop" rules and an instruction to follow the styles already in the code.

**The check in QA:**
- **Static check.** Before each QA run, the app checks only the lines the task added to UI files:
  - colors outside the palette and standard Tailwind colors;
  - radii, shadows and gradients that are not in the system;
  - forbidden patterns.

  The result is written to `design_check.md` in the task folder.
- **Check modes:** Block (default; QA won't approve with findings), Report only, Off.
- **Visual review.** The QA reviewer takes screenshots of the changed screens and states, compares them with the document and adds a "Design Review" table to the report.

**Applying a changed design system** (Context → Design system → Apply to the project): when the design system changes after the app is built, the block lists the files with the most differences and what happens next; **Plan the redesign** runs the same check over every UI file, without a model, and opens the spec import with a redesign brief: what the design system says, which files don't follow it and how many places, and how to split the work (the shell and shared components first, then the screens, behaviour unchanged). Read it, add what you want, and Analyse: the spec analyst proposes the tasks and you review them before they are created. Each one passes the design check and the UX review in QA, and you can look at it in Preview.

**Storybook** (a project option, off by default):
- when enabled, every new or changed UI component gets stories for its states (default, empty, loading, error, long text), and QA takes screenshots of them;
- if the project doesn't have Storybook yet, the next UI task sets it up. This adds dev dependencies to the project, which is why the option is explicit;
- the tab has Start Storybook: the app starts a dev server on a free port and opens it in your browser. It is the real Storybook: navigation, controls, addons, live reload;
- **before merging:** in the task window, Workspace → Storybook runs the Storybook of the task's worktree and opens it in your browser (the tab appears only when the task changed UI files in the Storybook's folder, not for an API-only task), so you can try the components the agent built while the task is in Human Review. The first start installs dependencies in the worktree (a few minutes and disk space); they are removed with the worktree, and the server stops when the worktree is cleaned up.

**Details worth knowing:**
- **No tokens, no automatic check.** It works only with `design-tokens.json`. If you connected your own document without tokens, the agents will read it but the static check won't: use Extract again or add tokens in Edit. The tab warns you about this.
- **Only new lines are checked.** Old project code that violates the system doesn't block the task. But if the task touched a line, that line must follow the system.
- **Extract again and New design replace the current document and tokens.** If the system lives in the repository, that file is the one overwritten. The tab asks for confirmation, but it's better to keep your version in git.
- **The design system doesn't go through task branches.** If it's in `.vibe-teamlead/`, agents get it from the main project at session start, so an edit in the tab takes effect from the agent's next session. If it's in a repository file, commit the change so it gets into the code as well.
- **False positives are possible.** For example, a hex-like string in text, or `rounded-full` for an avatar in a system with radius 0. Add the value to the tokens (radius `9999` for circles, the color to the palette) or switch to Report only.
- **Standard Tailwind colors count as violations when there is a palette.** If your system is intentionally built on them, add the shades you need to the palette or switch to Report only.
- **The font preview in the tab** shows fonts installed on your Mac. If a font is missing, you'll see the system font, even though the name is correct.
- **The project's Storybook in the Design system tab appears only after the task that set it up is merged:** agents work in the task branch. Before merging, use Workspace → Storybook in the task window. It adds dev dependencies to the project, so it's enabled manually. The first start can take up to a few minutes. If `npm install` hasn't been run after the setup, Storybook won't start.
- **Weaker models** follow the design system less well. That's why the main safeguard is the check in QA, not the prompt text itself.
