import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { evaluatePreToolUse, isSecretFileName } from '../security-hooks';
import type { ToolContext } from '../../tools/types';

const denied = (out: object) =>
  (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny';

const root = mkdtempSync(join(tmpdir(), 'vtl-secrets-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, '.env'), 'SECRET=1');
writeFileSync(join(root, 'src', 'app.ts'), 'x');
symlinkSync(join(root, '.env'), join(root, 'innocent.txt'));

const scan = { cwd: root, projectDir: root, specDir: root, agentType: 'deploy_readiness' } as unknown as ToolContext;
const coder = { ...scan, agentType: 'coder' } as unknown as ToolContext;

describe('isSecretFileName', () => {
  it.each(['.env', '.env.local', '.env.production', '.ENV', 'server.pem', 'tls.key', 'id_rsa', 'id_rsa.pub', 'id_rsa_work'])('%s is secret', (name) => {
    expect(isSecretFileName(name)).toBe(true);
  });
  it.each(['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.local.example', 'env.ts', 'keys.ts', 'package.json', '.envrc.md'])(
    '%s is not',
    (name) => {
      expect(isSecretFileName(name)).toBe(false);
    },
  );
});

describe('the readiness scan never reads secret files', () => {
  it('Read of a secret file is denied, relative, absolute or through a symlink; example files are fine', () => {
    expect(denied(evaluatePreToolUse('Read', { file_path: '.env' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Read', { file_path: join(root, '.env.local') }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Read', { file_path: join(root, 'certs', 'server.pem') }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Read', { file_path: join(root, 'innocent.txt') }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Read', { file_path: '.env.example' }, scan))).toBe(false);
    expect(denied(evaluatePreToolUse('Read', { file_path: 'src/app.ts' }, scan))).toBe(false);
  });

  it('Glob inside a secret path is denied; listing file names is fine', () => {
    expect(denied(evaluatePreToolUse('Glob', { pattern: '*', path: join(root, '.env') }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Glob', { pattern: '**/.env*' }, scan))).toBe(false);
  });

  it('Grep of a secret file is denied', () => {
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'SECRET', path: '.env' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'SECRET', path: join(root, 'innocent.txt') }, scan))).toBe(true);
  });

  it('Grep over a folder needs a glob that cannot match a secret file', () => {
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'process.env' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'process.env', path: root }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x', glob: '*' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x', glob: '**/*' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x', glob: '.env*' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x', glob: '*.{ts,key}' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x', glob: '!*.ts' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'process.env', glob: '*.{ts,tsx,js}' }, scan))).toBe(false);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'process.env', path: 'src', glob: '**/*.ts' }, scan))).toBe(false);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x', glob: '*.example' }, scan))).toBe(false);
  });

  it('Grep globs are an allowlist of extension patterns', () => {
    const grep = (input: Record<string, unknown>) => denied(evaluatePreToolUse('Grep', { pattern: 'x', ...input }, scan));
    expect(grep({ glob: '*', path: root })).toBe(true);
    expect(grep({ glob: '*.ts .env' })).toBe(true);
    expect(grep({ glob: '*.ts,.env' })).toBe(true);
    expect(grep({ glob: '*.{ts,env}' })).toBe(true);
    expect(grep({ glob: '*.[ek]*' })).toBe(true);
    expect(grep({ glob: '.env.example' })).toBe(true);
    expect(grep({ glob: 'src/**/*.ts' })).toBe(true);
    expect(grep({ glob: '**/*.{ts,tsx}' })).toBe(false);
    expect(grep({ glob: '*.yml' })).toBe(false);
    expect(grep({ glob: '**/*.prisma' })).toBe(false);
  });

  it('a path through a symlink to .env is denied for Read and Grep; package.json is fine', () => {
    writeFileSync(join(root, 'package.json'), '{}');
    expect(denied(evaluatePreToolUse('Read', { file_path: 'innocent.txt' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x', path: 'innocent.txt' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x', path: 'package.json' }, scan))).toBe(false);
    expect(denied(evaluatePreToolUse('Read', { file_path: 'package.json' }, scan))).toBe(false);
  });

  it('Read and Grep stay inside the project (realpath)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'vtl-outside-'));
    writeFileSync(join(outside, 'creds.txt'), 'x');
    symlinkSync(join(outside, 'creds.txt'), join(root, 'link-out.txt'));
    expect(denied(evaluatePreToolUse('Read', { file_path: join(outside, 'creds.txt') }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Read', { file_path: 'link-out.txt' }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x', path: outside, glob: '*.txt' }, scan))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('Grep of one ordinary file needs no glob', () => {
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x', path: 'src/app.ts' }, scan))).toBe(false);
  });

  it('other agents are not affected', () => {
    expect(denied(evaluatePreToolUse('Read', { file_path: '.env' }, coder))).toBe(false);
    expect(denied(evaluatePreToolUse('Grep', { pattern: 'x' }, coder))).toBe(false);
  });
});
