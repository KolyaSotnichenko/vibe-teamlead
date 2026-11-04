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
- the tab has Start Storybook: the app starts a dev server on a free port and shows the components inside the tab or in a browser.

**Details worth knowing:**
- **No tokens, no automatic check.** It works only with `design-tokens.json`. If you connected your own document without tokens, the agents will read it but the static check won't: use Extract again or add tokens in Edit. The tab warns you about this.
- **Only new lines are checked.** Old project code that violates the system doesn't block the task. But if the task touched a line, that line must follow the system.
- **Extract again and New design replace the current document and tokens.** If the system lives in the repository, that file is the one overwritten. The tab asks for confirmation, but it's better to keep your version in git.
- **The design system doesn't go through task branches.** If it's in `.vibe-teamlead/`, agents get it from the main project at session start, so an edit in the tab takes effect from the agent's next session. If it's in a repository file, commit the change so it gets into the code as well.
- **False positives are possible.** For example, a hex-like string in text, or `rounded-full` for an avatar in a system with radius 0. Add the value to the tokens (radius `9999` for circles, the color to the palette) or switch to Report only.
- **Standard Tailwind colors count as violations when there is a palette.** If your system is intentionally built on them, add the shades you need to the palette or switch to Report only.
- **The font preview in the tab** shows fonts installed on your Mac. If a font is missing, you'll see the system font, even though the name is correct.
- **Storybook appears in the tab only after the task that set it up is merged:** agents work in the task branch. It adds dev dependencies to the project, so it's enabled manually. The first start can take up to a few minutes. If `npm install` hasn't been run after the setup, Storybook won't start.
- **Weaker models** follow the design system less well. That's why the main safeguard is the check in QA, not the prompt text itself.
