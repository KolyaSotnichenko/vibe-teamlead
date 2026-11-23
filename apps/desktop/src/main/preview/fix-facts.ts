/**
 * What the app already knows about a project that did not start, for the agent that fixes
 * the start (fix-start.ts): whether Docker answers, which runtimes and tools are on the
 * search path, what the preview starts in Docker for the project, each service's variables
 * by name with where each came from, and the project's RUNNING.md. Names and sources only:
 * no value of any variable goes to the agent. Pure.
 */

import type { PreviewEnvReport } from '../../shared/types/preview';

/** The runtimes and tools a project's start may need */
export const FIX_TOOLS = ['node', 'pnpm', 'npm', 'yarn', 'bun', 'python3', 'uv', 'poetry', 'ruby', 'bundle', 'php', 'composer', 'go'] as const;
const RUNNING_MD_CHARS = 8 * 1024;

export interface FixFactsInput {
  dockerAnswers: boolean;
  onPath: (name: string) => boolean;
  /** The Environment report of the project's preview */
  env: PreviewEnvReport;
  /** The project's RUNNING.md, null when it has none */
  runningMd: string | null;
}

export function fixFacts(input: FixFactsInput): string[] {
  const found = FIX_TOOLS.filter((name) => input.onPath(name));
  const missing = FIX_TOOLS.filter((name) => !input.onPath(name));
  const inDocker = [...input.env.databases, ...(input.env.composeServices ?? []), ...(input.env.mail ? ['a mail catcher'] : [])];
  const lines = [
    input.dockerAnswers ? 'Docker answers.' : 'Docker does not answer: it is not installed or not running.',
    found.length ? `On the search path: ${found.join(', ')}.` : 'None of the usual runtimes is on the search path.',
    ...(missing.length ? [`Not on the search path: ${missing.join(', ')}.`] : []),
    inDocker.length ? `The preview starts in Docker for this project: ${inDocker.join(', ')}.` : 'The preview starts nothing in Docker for this project (its compose file names no image).',
    '',
    'The variables each service gets, by name, with where each value comes from (values are not shown):',
  ];
  for (const service of input.env.services) {
    lines.push(`- ${service.service} (${service.dir || 'the project root'}):`);
    for (const variable of service.vars) lines.push(`  - ${variable.name} [${variable.source}${variable.value === '' && !variable.pending ? ', empty' : ''}]`);
  }
  if (!input.env.services.length) lines.push('- (no services are known yet)');
  lines.push('', input.runningMd === null ? 'The project has no RUNNING.md.' : `The project's RUNNING.md:\n\n${input.runningMd.slice(0, RUNNING_MD_CHARS)}`);
  return lines;
}
