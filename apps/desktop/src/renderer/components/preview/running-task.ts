/**
 * "Write RUNNING.md" as a task, without a model call: for a project the preview can't
 * run by itself, the agents write down how to run it. The same sections as the coder
 * prompt's template (prompts/coder.md, "RUNNING.md"). Pure.
 */

export const RUNNING_MD_SECTIONS = ['Prerequisites', 'Setup', 'Database', 'Start', 'Signing in locally', 'Common problems'] as const;

export function runningTask(): { title: string; description: string } {
  return {
    title: 'Write RUNNING.md: how to run this project',
    description: [
      'Write `RUNNING.md` at the project root: how a developer runs this project on their own machine, from a fresh clone. The app shows it in Preview when it cannot start the project itself, and agents keep it up to date from now on.',
      '',
      "Read the project first: package files, scripts, compose files, `.env.example`, configs, the README. Don't change the project's code; this task adds `RUNNING.md` and nothing else (if `.env.example` lacks a variable the project needs, list it in `RUNNING.md` and say it is missing there).",
      '',
      'Check every command you document: run it where it is safe (installs, builds, starting a service and stopping it again, migrations against a local throwaway database). Never run anything against a shared or production system. A command you could not run is marked "not checked" with the reason.',
      '',
      'Sections, in this order (write "Not needed" for one that does not apply):',
      '',
      '1. **Prerequisites**: runtimes and their versions, Docker, other tools.',
      '2. **Setup**: installing dependencies; the environment variables, from `.env.example`, with what each one is for. Placeholders only, never real values.',
      '3. **Database**: starting it, migrations, seed data.',
      '4. **Start**: the command for each service, the folder it runs in, its port and the URL to open.',
      '5. **Signing in locally**: test users, or how to get past single sign-on (for example Entra ID) in development, if the project has a way. If it has none, say so.',
      '6. **Common problems**: what goes wrong (a port already taken, a missing variable, a container not running) and the fix.',
      '',
      'Commands go in fenced code blocks, one per step, for macOS and Linux; add the Windows command where it differs.',
      '',
      '## Acceptance criteria',
      '',
      `- AC-1: \`RUNNING.md\` exists at the project root with the sections ${RUNNING_MD_SECTIONS.join(', ')}, in that order.`,
      '- AC-2: Every command in it was run and worked, or is marked "not checked" with the reason.',
      '- AC-3: It has no real secrets: variables come from `.env.example`, with placeholders.',
      "- AC-4: The project's code is unchanged; the task adds only `RUNNING.md`.",
    ].join('\n'),
  };
}
