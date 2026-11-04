# Design system and Storybook

**What it is.** The project's document (`design-system.md`) and tokens (`design-tokens.json`):
- a palette with color roles, fonts and a size scale, spacing, radii;
- whether shadows and gradients are allowed;
- components and their states;
- rules for interface text;
- a "never" list (forbidden patterns).

**Where it lives.** In the project's `.vibe-teamlead/`, or in a repository file (`DESIGN-SYSTEM.md` at the root, `design/` or `docs/`), or at a path you specify.

**How it's created** (Context → Design system):
- **Extract from the code:** the agent reads the theme, CSS variables and components and writes down the visual language that already exists;
- **Design a new one:** you describe the product, audience and mood → the agent proposes three different directions (palette, fonts, principles) → you choose → it writes the full system;
- **File in the repository:** point to your own document.

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
