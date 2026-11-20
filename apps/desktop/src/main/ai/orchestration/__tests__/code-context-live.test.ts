/**
 * The code context against the real CodeGraph.
 *
 * The parsing is tested on text copied from CodeGraph; only the binary knows
 * whether it still prints that text, and whether its index follows a file that
 * was edited between sessions (it does not, until `sync`: measured on 1.6.2).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { resolveDevTools } from '../../claude-code/bundled-tools';
import { indexProject, resetCodegraphIndexCache } from '../../claude-code/codegraph';
import { isWindowsHost } from '../../../platform/__tests__/host';
import { sessionCodeContext, subtaskCodeContext } from '../code-context';

const APP = resolve(__dirname, '../../../../..');
const bin = resolveDevTools(APP).codegraphBin;

const MATH = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n';
const USE = 'import { add } from "./math";\nimport { route7 } from "./routes";\n\nexport const two = add(1, 1) + route7("x").length;\n';
const ROUTES = Array.from({ length: 220 }, (_, i) => `export function route${i}(input: string): string {\n  return input + "${i}";\n}\n`).join('\n');

describe.skipIf(isWindowsHost || !bin)('code context with the real CodeGraph', () => {
  let dir: string;
  const logs: string[] = [];
  const log = (line: string) => {
    logs.push(line);
  };

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'vtl-cg-live-')));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'math.ts'), MATH);
    writeFileSync(join(dir, 'src', 'use.ts'), USE);
    writeFileSync(join(dir, 'src', 'routes.ts'), ROUTES);
    resetCodegraphIndexCache();
    expect(await indexProject(bin as string, dir)).toBe(true);
    // An earlier session edited the file after the index was built, and nothing watched the folder since
    writeFileSync(join(dir, 'src', 'routes.ts'), `// moved\n// three lines\n// down\n${ROUTES}`);
  }, 120_000);

  it('gives the small file whole with who uses it, and the edited large file as a map with its current line numbers', async () => {
    const block = await subtaskCodeContext({
      bin,
      projectDir: dir,
      subtask: { id: 'subtask-1-1', files_to_modify: ['src/math.ts'], patterns_from: ['src/routes.ts'] },
      log,
    });

    expect(block).toContain('### `src/math.ts` — whole file, 7 lines · used by 1 file: src/use.ts');
    expect(block).toContain('1\texport function add(a: number, b: number): number {');
    expect(block).toMatch(/### `src\/routes\.ts` — map, 882 lines, \d+\.\d KB · used by 1 file: src\/use\.ts/);
    expect(block.length).toBeLessThanOrEqual(12 * 1024);

    // Every line number the map gives is where that function is in the file now
    const source = readFileSync(join(dir, 'src', 'routes.ts'), 'utf-8').split('\n');
    const symbols = [...block.matchAll(/^- :(\d+) `(route\d+)` function/gm)];
    expect(symbols.length).toBeGreaterThan(10);
    for (const [, line, name] of symbols) expect(source[Number(line) - 1]).toContain(`function ${name}(`);
    expect(symbols[0].slice(1)).toEqual(['4', 'route0']);

    expect(logs.at(-1)).toMatch(/^Code context for subtask-1-1: \d+\.\d KB \(1 whole file, 1 CodeGraph map\)$/);
  }, 60_000);

  it('gives a reviewer maps of the changed files', async () => {
    const block = await sessionCodeContext({
      agentType: 'qa_reviewer',
      specDir: join(dir, '.vibe-teamlead', 'specs', '001'),
      projectDir: dir,
      bin,
      changedFiles: async () => ['src/math.ts', 'src/use.ts'],
      log,
    });

    expect(block).toContain('### `src/math.ts` — map, 7 lines');
    expect(block).toContain('- :1 `add` function (a: number, b: number): number');
    expect(block).toContain('- :5 `sub` function (a: number, b: number): number');
    expect(block).not.toContain('return a + b;');
    expect(logs.at(-1)).toMatch(/^Code context for the QA reviewer: \d+\.\d KB \(2 CodeGraph maps\)$/);
  }, 60_000);
});
