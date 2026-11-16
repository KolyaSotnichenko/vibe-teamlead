/**
 * Vendored shell scripts run with bash, also on Windows (Git Bash): a CRLF checkout breaks
 * them ($'\r': command not found). The root .gitattributes keeps every one of them LF.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESKTOP = join(__dirname, '..', '..', '..');
const REPO = join(DESKTOP, '..', '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const isShellScript = (file: string) => file.endsWith('.sh') || file.endsWith('run-hook.cmd') || /^#!.*\b(ba)?sh\b/.test(readFileSync(file, 'utf8').split('\n')[0]);

describe('.gitattributes', () => {
  it('checks out every vendored shell script with LF line endings', () => {
    const scripts = files(join(DESKTOP, 'vendor')).filter(isShellScript).map((f) => relative(REPO, f));
    expect(scripts.length).toBeGreaterThan(5);
    const out = execFileSync('git', ['check-attr', 'eol', '--', ...scripts], { cwd: REPO, encoding: 'utf8' });
    const notLf = out
      .trim()
      .split('\n')
      .filter((line) => !line.endsWith(': eol: lf'));
    expect(notLf).toEqual([]);
  });
});
