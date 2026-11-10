/**
 * After electron-vite builds: every main, preload and worker file must parse. Its CommonJS shim
 * goes after the last import-looking text in a bundle, strings and kept comments included, and a
 * comment like `("Spec document import")` once put it inside a string: the app would not start.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = ['out/main', 'out/preload'];
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.js') || full.endsWith('.mjs') ? [full] : [];
  });

let failed = 0;
for (const root of roots) {
  for (const file of files(root)) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      failed++;
      process.stderr.write(`${file} does not parse:\n${String(error.stderr ?? error.message)}\n`);
    }
  }
}
if (failed) process.exit(1);
