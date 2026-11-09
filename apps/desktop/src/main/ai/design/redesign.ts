/**
 * Applying a changed design system to a project that is already built. The design check QA
 * runs looks only at the lines a task adds, so code written before the change keeps its old
 * look. This runs the same check over every tracked UI file, without a model, and writes a
 * brief from it that the spec analyst splits into redesign tasks the owner reviews.
 */

import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { DesignFinding, DesignTokens } from '../../../shared/types';
import { type AddedLines, isUiFile, lintAddedLines } from './design-lint';

const run = promisify(execFile);
const FILE_MAX = 512 * 1024;
const READ_AT_ONCE = 32;
const DESIGN_SYSTEM_MAX = 12_000;
const FILES_LISTED = 80;
const SAMPLES_PER_FILE = 2;

/** Every tracked UI file of the project, checked whole against the design tokens. */
export async function auditProjectDesign(projectPath: string, tokens: DesignTokens, git = 'git'): Promise<{ findings: DesignFinding[]; uiFiles: string[] }> {
  const { stdout } = await run(git, ['ls-files', '-z'], { cwd: projectPath, maxBuffer: 64 * 1024 * 1024 });
  const uiFiles = stdout.split('\0').filter((file) => file && isUiFile(file)).sort();
  const files: AddedLines[] = [];
  const readOne = async (file: string) => {
    const full = path.join(projectPath, file);
    const info = await lstat(full).catch(() => null);
    if (!info?.isFile() || info.size > FILE_MAX) return;
    const text = await readFile(full, 'utf-8').catch(() => '');
    files.push({ file, lines: text.split('\n').map((line, i) => ({ n: i + 1, text: line })) });
  };
  for (let i = 0; i < uiFiles.length; i += READ_AT_ONCE) await Promise.all(uiFiles.slice(i, i + READ_AT_ONCE).map(readOne));
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { findings: lintAddedLines(files, tokens), uiFiles };
}

export interface RedesignInput {
  /** Where the design system lives, relative to the project */
  designSystemPath: string;
  designSystem: string;
  findings: DesignFinding[];
  uiFiles: string[];
}

/** The redesign brief for the spec analyst. Pure. */
export function redesignBrief(input: RedesignInput): string {
  const byFile = new Map<string, DesignFinding[]>();
  for (const finding of input.findings) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  const system = input.designSystem.length > DESIGN_SYSTEM_MAX ? `${input.designSystem.slice(0, DESIGN_SYSTEM_MAX)}\n\n…(the rest is in the file)` : input.designSystem;

  const violations = files.length
    ? [
        `The design check finds ${input.findings.length} places in ${files.length} files that don't follow it (colours outside the palette, radii, shadows, gradients, banned patterns):`,
        '',
        ...files.slice(0, FILES_LISTED).flatMap(([file, found]) => [
          `- \`${file}\`: ${found.length} (${[...new Set(found.map((f) => f.rule))].join(', ')})`,
          ...found.slice(0, SAMPLES_PER_FILE).map((f) => `  - line ${f.line}: \`${f.match.slice(0, 80)}\``),
        ]),
        ...(files.length > FILES_LISTED ? [`- …and ${files.length - FILES_LISTED} more files`] : []),
      ]
    : ['The code already passes the design check (palette, radii, shadows), so what is left is what a check can\'t see: layout, hierarchy, type scale, spacing and components.'];

  return [
    '# Redesign: bring the existing UI to the project\'s design system',
    '',
    `The design system changed and the UI built before it still has the old look. Rework the existing screens to follow it. The design system is \`${input.designSystemPath}\`; it is the source of truth for colours, type, spacing, radii, components and tone.`,
    '',
    '## The design system',
    '',
    system,
    '',
    '## Where the code does not follow it',
    '',
    ...violations,
    '',
    `The project has ${input.uiFiles.length} UI files.`,
    '',
    '## How to split the work',
    '',
    '- First the app shell and navigation, and the shared components (buttons, inputs, cards, dialogs, tables) everything else uses.',
    '- Then the screens, one area of the product per task, using those components.',
    '- Behaviour stays as it is: the same routes, data, validation and copy, unless the design system changes the copy\'s tone.',
    '- Each task: the design check is clean on the files it touches, and its screens follow the design system at phone and desktop widths.',
  ].join('\n');
}
