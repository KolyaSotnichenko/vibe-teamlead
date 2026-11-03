/**
 * The agent worker runs in a worker thread, where `electron` cannot be loaded:
 * a static `import … from 'electron'` anywhere in its import graph stops every
 * agent with "The requested module 'electron' does not provide an export named
 * 'app'". Unit tests mock electron, so this walks the real source graph.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', '..', '..');
const WORKER = join(SRC, 'main', 'ai', 'agent', 'worker.ts');

/** Runtime (non-type) relative imports of a file */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, 'utf-8');
  const specs: string[] = [];
  for (const m of source.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gms)) {
    if (!m[1]) specs.push(m[2]);
  }
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

function resolve(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = normalize(join(dirname(from), spec));
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base].find((p) => existsSync(p) && p.match(/\.tsx?$/));
}

function staticElectronImport(file: string): boolean {
  return /^import\s+(?!type\b)[^;]*?from\s+['"]electron['"]/m.test(readFileSync(file, 'utf-8'));
}

describe('agent worker bundle', () => {
  it('never statically imports electron', () => {
    const parent = new Map<string, string | null>([[WORKER, null]]);
    const queue = [WORKER];
    while (queue.length) {
      const file = queue.shift() as string;
      for (const spec of runtimeImports(file)) {
        const target = resolve(file, spec);
        if (target && !parent.has(target)) {
          parent.set(target, file);
          queue.push(target);
        }
      }
    }
    const offenders = [...parent.keys()].filter(staticElectronImport).map((file) => {
      const chain: string[] = [];
      for (let f: string | null | undefined = file; f; f = parent.get(f)) chain.push(relative(SRC, f));
      return chain.join(' <- ');
    });
    expect(parent.size).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
