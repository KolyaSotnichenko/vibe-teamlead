import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { changedFiles, formatGateReport, isLockfile, parseGitleaks, parseOsv, parseSemgrep, resolveBaseRef, runSecurityGates } from '../gates';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vtl-gates-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'README.md'), '# app\n');
  writeFileSync(join(dir, 'package-lock.json'), '{"v":1}\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  g('checkout', '-qb', 'task');
  writeFileSync(join(dir, 'config.ts'), 'export const key = "x";\n');
  g('add', '.');
  g('commit', '-qm', 'work');
  writeFileSync(join(dir, 'new.ts'), 'untracked\n');
  writeFileSync(join(dir, 'package-lock.json'), '{"v":2}\n');
  return dir;
}

/** A fake scanner: writes canned JSON to --report-path (gitleaks) or stdout (osv). */
function fakeScanner(dir: string, name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('gate parsers', () => {
  it('parses gitleaks findings', () => {
    const findings = parseGitleaks(JSON.stringify([{ RuleID: 'aws-access-token', Description: 'AWS', File: 'a.ts', StartLine: 2, Commit: 'abcdef1234567' }]));
    expect(findings).toEqual([expect.objectContaining({ gate: 'gitleaks', file: 'a.ts', line: 2, title: 'Secret detected: AWS' })]);
    expect(parseGitleaks('not json')).toEqual([]);
  });

  it('parses OSV results into one finding per advisory group', () => {
    const osv = {
      results: [{
        source: { path: '/x/package-lock.json' },
        packages: [{
          package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' },
          vulnerabilities: [{ id: 'GHSA-1', summary: 'Prototype pollution' }, { id: 'CVE-1' }],
          groups: [{ ids: ['GHSA-1', 'CVE-1'], max_severity: '7.4' }],
        }],
      }],
    };
    const findings = parseOsv(JSON.stringify(osv), 'package-lock.json');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ key: 'osv:lodash@4.17.20:GHSA-1', file: 'package-lock.json', detail: 'Prototype pollution' });
    expect(findings[0].title).toContain('CVSS 7.4');
  });

  it('parses Semgrep JSON into one blocking finding per ERROR result', () => {
    const semgrep = {
      results: [
        { check_id: 'javascript.express.security.injection.tainted-sql-string', path: 'src/db.ts', start: { line: 12, col: 5 }, extra: { message: 'Detected SQL statement built from user input.', severity: 'ERROR' } },
        { check_id: 'javascript.lang.security.audit.detect-eval', path: 'src/util.ts', start: { line: 3, col: 1 }, extra: { message: 'eval is dangerous', severity: 'WARNING' } },
      ],
      errors: [],
    };
    const findings = parseSemgrep(JSON.stringify(semgrep));
    expect(findings).toEqual([
      {
        gate: 'semgrep',
        key: 'semgrep:javascript.express.security.injection.tainted-sql-string:src/db.ts:12',
        title: 'javascript.express.security.injection.tainted-sql-string: Detected SQL statement built from user input.',
        file: 'src/db.ts',
        line: 12,
      },
    ]);
    expect(parseSemgrep('not json')).toEqual([]);
  });

  it('recognises lockfiles by name', () => {
    expect(isLockfile('apps/web/pnpm-lock.yaml')).toBe(true);
    expect(isLockfile('src/lock.ts')).toBe(false);
  });

  it('formats a blocked report with fix guidance', () => {
    const md = formatGateReport({ ran: ['gitleaks'], skipped: [{ gate: 'osv-scanner', reason: 'no dependency lockfiles changed' }], findings: [{ gate: 'gitleaks', key: 'k', title: 'Secret detected: AWS', file: 'a.ts', line: 2 }] });
    expect(md).toContain('Status: BLOCKED');
    expect(md).toContain('`a.ts:2`');
    expect(md).toContain('Skipped osv-scanner');
  });
});

describe('runSecurityGates', () => {
  it('finds changed files against the default branch', async () => {
    const dir = repo();
    const base = await resolveBaseRef(dir);
    expect(base).toBeTruthy();
    expect((await changedFiles(dir, base)).sort()).toEqual(['config.ts', 'new.ts', 'package-lock.json']);
  });

  it('reports secrets and only newly introduced vulnerabilities, and writes the report', async () => {
    const dir = repo();
    const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
    // dir mode: report config.ts if it is in the scanned tree; git mode: nothing.
    const gitleaks = fakeScanner(
      bin,
      'gitleaks',
      `mode="$1"; while [ $# -gt 0 ]; do case "$1" in --report-path) out="$2"; shift;; esac; last="$1"; shift; done
if [ "$mode" = dir ] && [ -f "$last/config.ts" ]; then echo '[{"RuleID":"generic-api-key","Description":"Generic API Key","File":"'$last'/config.ts","StartLine":1}]' > "$out"; else echo '[]' > "$out"; fi`,
    );
    // Base lockfile ({"v":1}) has GHSA-old; the new one has GHSA-old and GHSA-new.
    const osv = fakeScanner(
      bin,
      'osv-scanner',
      `for a in "$@"; do f="$a"; done
pkg='{"package":{"name":"left-pad","version":"1.0.0"},"groups":[{"ids":["GHSA-old"]}]'
if grep -q '"v":2' "$f"; then pkg="$pkg},{\\"package\\":{\\"name\\":\\"left-pad\\",\\"version\\":\\"1.0.0\\"},\\"groups\\":[{\\"ids\\":[\\"GHSA-new\\"]}]"; fi
echo "{\\"results\\":[{\\"packages\\":[$pkg}]}]}"`,
    );
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const report = await runSecurityGates({ projectDir: dir, specDir, gitleaksBin: gitleaks, osvScannerBin: osv });

    expect(report.ran).toEqual(['gitleaks', 'osv-scanner']);
    const keys = report.findings.map((f) => f.key);
    expect(keys.some((k) => k.startsWith('gitleaks:generic-api-key:config.ts'))).toBe(true);
    expect(keys).toContain('osv:left-pad@1.0.0:GHSA-new');
    expect(keys).not.toContain('osv:left-pad@1.0.0:GHSA-old');
    expect(readFileSync(join(specDir, 'security_gates.md'), 'utf-8')).toContain('BLOCKED');
  });

  it("ignores the app's own folder (task logs quote the agents' test tokens)", async () => {
    const dir = repo();
    // The project doesn't ignore .vibe-teamlead/, so its task logs show as untracked
    mkdirSync(join(dir, '.vibe-teamlead', 'specs', '003-auth'), { recursive: true });
    writeFileSync(join(dir, '.vibe-teamlead', 'specs', '003-auth', 'task_logs.json'), '{"token":"sk_test_123"}');
    const base = await resolveBaseRef(dir);
    expect(await changedFiles(dir, base)).not.toContain('.vibe-teamlead/specs/003-auth/task_logs.json');

    // A scanner that flags every file it is given, and a commit that touched the folder
    const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
    const gitleaks = fakeScanner(
      bin,
      'gitleaks',
      `mode="$1"; while [ $# -gt 0 ]; do case "$1" in --report-path) out="$2"; shift;; esac; last="$1"; shift; done
if [ "$mode" = dir ]; then
  printf '[' > "$out"; sep=''; for f in $(cd "$last" && find . -type f | sed 's|^./||'); do printf '%s{"RuleID":"generic-api-key","File":"%s/%s","StartLine":1}' "$sep" "$last" "$f" >> "$out"; sep=','; done; printf ']' >> "$out"
else echo '[{"RuleID":"generic-api-key","File":".vibe-teamlead/specs/003-auth/task_logs.json","StartLine":3,"Commit":"abcdef1234"}]' > "$out"; fi`,
    );
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const report = await runSecurityGates({ projectDir: dir, specDir, gitleaksBin: gitleaks });

    const files = report.findings.map((f) => f.file);
    expect(files).toContain('config.ts');
    expect(files.filter((f) => f?.includes('.vibe-teamlead'))).toEqual([]);
  });

  it('skips missing scanners instead of failing', async () => {
    const dir = repo();
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const report = await runSecurityGates({ projectDir: dir, specDir });
    expect(report.ran).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.skipped.map((s) => s.gate)).toEqual(['gitleaks', 'osv-scanner', 'semgrep']);
    expect(report.skipped.find((s) => s.gate === 'semgrep')?.reason).toBe('Semgrep is not installed');
  });
});

describe('Semgrep gate', () => {
  it('scans only the changed files and blocks on ERROR findings', async () => {
    const dir = repo();
    const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
    const semgrep = fakeScanner(
      bin,
      'semgrep',
      `echo "$@" > "${bin}/args"
echo '{"results":[{"check_id":"js.sqli","path":"config.ts","start":{"line":1,"col":1},"extra":{"message":"SQL built from input","severity":"ERROR"}},{"check_id":"js.warn","path":"new.ts","start":{"line":1,"col":1},"extra":{"message":"meh","severity":"WARNING"}}],"errors":[]}'`,
    );
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const report = await runSecurityGates({ projectDir: dir, specDir, semgrepBin: semgrep });
    expect(report.ran).toEqual(['semgrep']);
    expect(report.findings).toEqual([expect.objectContaining({ gate: 'semgrep', key: 'semgrep:js.sqli:config.ts:1', file: 'config.ts', line: 1, title: 'js.sqli: SQL built from input' })]);
    const args = readFileSync(join(bin, 'args'), 'utf-8').trim().split(' ');
    expect(args.slice(0, 9)).toEqual(['scan', '--config', 'auto', '--severity', 'ERROR', '--json', '--quiet', '--metrics=off', '--']);
    expect(args.slice(9).sort()).toEqual(['config.ts', 'new.ts', 'package-lock.json']);
    expect(readFileSync(join(specDir, 'security_gates.md'), 'utf-8')).toContain('[semgrep] js.sqli: SQL built from input');
  });

  it('is skipped, not failed, when the rules cannot be fetched', async () => {
    const dir = repo();
    const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
    const semgrep = fakeScanner(bin, 'semgrep', 'echo "Failed to download configuration. HINT: check your network connection" >&2; exit 2');
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const report = await runSecurityGates({ projectDir: dir, specDir, semgrepBin: semgrep });
    expect(report.ran).not.toContain('semgrep');
    expect(report.findings).toEqual([]);
    expect(report.skipped).toContainEqual({ gate: 'semgrep', reason: 'Semgrep could not fetch its rules (network or registry): Failed to download configuration. HINT: check your network connection' });
  });

  it('is skipped when it times out or crashes', async () => {
    const dir = repo();
    const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
    const slow = fakeScanner(bin, 'semgrep-slow', 'exec sleep 5');
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const timedOut = await runSecurityGates({ projectDir: dir, specDir, semgrepBin: slow, semgrepTimeoutMs: 100 });
    expect(timedOut.skipped).toContainEqual({ gate: 'semgrep', reason: 'failed — Semgrep timed out' });
    const broken = fakeScanner(bin, 'semgrep-broken', 'echo "invalid rule" >&2; exit 7');
    const crashed = await runSecurityGates({ projectDir: dir, specDir, semgrepBin: broken });
    expect(crashed.skipped).toContainEqual({ gate: 'semgrep', reason: 'failed — Semgrep exited with code 7: invalid rule' });
  });

  it('has nothing to scan when no file changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vtl-gates-'));
    const g = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    writeFileSync(join(dir, 'README.md'), '# app\n');
    g('add', '.');
    g('commit', '-qm', 'base');
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const report = await runSecurityGates({ projectDir: dir, specDir, semgrepBin: '/nonexistent/semgrep' });
    expect(report.skipped).toContainEqual({ gate: 'semgrep', reason: 'no files changed' });
  });
});

describe('scanner failures', () => {
  it('records a crashing scanner as failed instead of reporting it clean', async () => {
    const dir = repo();
    const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
    const broken = fakeScanner(bin, 'gitleaks', 'echo "config error" >&2; exit 2');
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const report = await runSecurityGates({ projectDir: dir, specDir, gitleaksBin: broken });
    expect(report.ran).not.toContain('gitleaks');
    expect(report.skipped).toContainEqual({ gate: 'gitleaks', reason: 'failed — gitleaks exited with code 2: config error' });
    expect(readFileSync(join(specDir, 'security_gates.md'), 'utf-8')).toContain('Skipped gitleaks: failed');
  });
});
