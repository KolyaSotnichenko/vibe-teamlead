import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildStrixArgs,
  DEFAULT_STRIX_SETTINGS,
  formatFixRequest,
  isBlocking,
  parseSarif,
  runStrix,
  strixModel,
} from '../strix';

const SARIF = JSON.stringify({
  version: '2.1.0',
  runs: [
    {
      tool: {
        driver: {
          name: 'strix',
          rules: [
            { id: 'sqli', shortDescription: { text: 'SQL injection in invoice search' }, properties: { 'security-severity': '9.1' } },
            { id: 'hdr', shortDescription: { text: 'Missing security header' }, properties: { severity: 'low' } },
          ],
        },
      },
      results: [
        {
          ruleId: 'sqli',
          level: 'error',
          message: { text: 'The q parameter is concatenated into SQL.\nPoC: ?q=1%27%20OR%201=1' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'api/src/invoices.ts' }, region: { startLine: 42 } } }],
        },
        { ruleId: 'hdr', level: 'note', message: { text: 'X-Content-Type-Options is not set' } },
      ],
    },
  ],
});

const settings = { ...DEFAULT_STRIX_SETTINGS, enabled: true };

describe('Strix helpers', () => {
  it('parses SARIF findings with severity from rule properties', () => {
    const findings = parseSarif(SARIF);
    expect(findings).toEqual([
      expect.objectContaining({ ruleId: 'sqli', title: 'SQL injection in invoice search', severity: 'critical', location: 'api/src/invoices.ts:42' }),
      expect.objectContaining({ ruleId: 'hdr', severity: 'low' }),
    ]);
    expect(parseSarif('nope')).toEqual([]);
  });

  it('blocks at the threshold and above, and always on unknown severity', () => {
    const [sqli, hdr] = parseSarif(SARIF);
    expect(isBlocking(sqli, 'high')).toBe(true);
    expect(isBlocking(hdr, 'high')).toBe(false);
    expect(isBlocking({ ruleId: 'x', title: 'x', severity: 'unknown' }, 'critical')).toBe(true);
  });

  it('scans only the diff, headless, with a budget cap', () => {
    const args = buildStrixArgs({ projectDir: '/wt', settings, diffBase: 'abc123' }, '/spec/security/instructions.md');
    expect(args).toEqual(
      expect.arrayContaining(['--non-interactive', '--target', '/wt', '--scope-mode', 'diff', '--diff-base', 'abc123', '--fail-on', 'high', '--max-budget', '5']),
    );
    expect(strixModel('claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(strixModel('openrouter/x')).toBe('openrouter/x');
  });

  it('writes a fix request with only blocking findings', () => {
    const md = formatFixRequest({ status: 'findings', findings: parseSarif(SARIF) }, settings, '/spec');
    expect(md).toContain('SQL injection in invoice search');
    expect(md).not.toContain('Missing security header');
    expect(md).toContain('failing test');
  });
});

describe('runStrix', () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function fakeBin(name: string, script: string, dir: string) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it('skips without an API key, with a subscription token, or without Strix', async () => {
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-strix-'));
    const base = { projectDir: specDir, specDir, settings, model: 'claude-sonnet-4-6' };
    expect((await runStrix(base)).status).toBe('skipped');
    expect((await runStrix({ ...base, apiKey: 'sk-ant-oat01-x' })).reason).toMatch(/API key/);
    process.env.PATH = mkdtempSync(join(tmpdir(), 'vtl-empty-'));
    const missing = await runStrix({ ...base, apiKey: 'sk-ant-api-x', strixBin: undefined });
    // Strix may exist in a common install dir on a dev machine; only assert when it doesn't.
    if (missing.status === 'skipped') expect(missing.reason).toMatch(/not installed|Docker/);
    expect(readFileSync(join(specDir, 'security_qa.md'), 'utf-8')).toContain('Security QA');
  });

  it('runs Strix and reports blocking findings from its SARIF', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const sarifFile = join(bin, 'findings.sarif');
    writeFileSync(sarifFile, SARIF);
    fakeBin('docker', 'exit 0', bin);
    const strix = fakeBin(
      'strix',
      `[ "$STRIX_TELEMETRY" = "0" ] || exit 9
[ "$STRIX_LLM" = "anthropic/claude-sonnet-4-6" ] || exit 8
mkdir -p strix_runs/run-1 && cp "${sarifFile}" strix_runs/run-1/findings.sarif
echo '{"status":"completed","llm_usage":{"cost":1.25}}' > strix_runs/run-1/run.json
echo "found 2"; exit 2`,
      bin,
    );
    process.env.PATH = `${bin}:${originalPath}`;
    const logs: string[] = [];
    const result = await runStrix({ projectDir: specDir, specDir, settings, model: 'claude-sonnet-4-6', apiKey: 'sk-ant-api-x', strixBin: strix, onLog: (l) => logs.push(l) });

    expect(result.status).toBe('findings');
    expect(result.costUsd).toBe(1.25);
    expect(result.findings.filter((f) => isBlocking(f, 'high'))).toHaveLength(1);
    expect(logs).toContain('[strix] found 2');
    const md = readFileSync(join(specDir, 'security_qa.md'), 'utf-8');
    expect(md).toContain('BLOCKED');
    expect(md).toContain('spent $1.25');
  });

  it('treats a clean exit as clear and other exits as a non-blocking error', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'vtl-bin-'));
    fakeBin('docker', 'exit 0', bin);
    process.env.PATH = `${bin}:${originalPath}`;
    const specDir = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    const opts = { projectDir: specDir, specDir, settings, model: 'claude-sonnet-4-6', apiKey: 'sk-ant-api-x' };
    expect((await runStrix({ ...opts, strixBin: fakeBin('strix-ok', 'exit 0', bin) })).status).toBe('clear');
    expect((await runStrix({ ...opts, strixBin: fakeBin('strix-bad', 'exit 1', bin) })).status).toBe('error');
  });
});
