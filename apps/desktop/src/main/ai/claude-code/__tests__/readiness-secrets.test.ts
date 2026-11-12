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
for (const name of ['.env', '.env.json', '.env.local.yml', 'id_rsa.txt', '.env.example', 'package.json']) writeFileSync(join(root, name), 'x');
writeFileSync(join(root, 'src', 'app.ts'), 'x');
symlinkSync(join(root, '.env'), join(root, 'innocent.txt'));

const scan = { cwd: root, projectDir: root, specDir: root, agentType: 'deploy_readiness' } as unknown as ToolContext;
const coder = { ...scan, agentType: 'coder' } as unknown as ToolContext;
const read = (file_path: string, ctx = scan) => denied(evaluatePreToolUse('Read', { file_path }, ctx));
const grep = (input: Record<string, unknown>, ctx = scan) => denied(evaluatePreToolUse('Grep', { pattern: 'x', ...input }, ctx));

describe('isSecretFileName', () => {
  it.each([
    '.env', '.env.local', '.env.production', '.ENV', '.env.json', '.env.local.yml', '.envrc',
    'server.pem', 'tls.key', 'cert.p12', 'cert.pfx', 'id_rsa', 'id_rsa.pub', 'id_rsa.txt',
    'id_ed25519', 'id_ecdsa', 'id_dsa', 'credentials', '.npmrc', '.netrc', '.pgpass',
  ])('%s is secret', (name) => {
    expect(isSecretFileName(name)).toBe(true);
  });
  it.each(['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.local.example', 'env.ts', 'keys.ts', 'package.json'])('%s is not', (name) => {
    expect(isSecretFileName(name)).toBe(false);
  });
});

describe('the readiness scan never reads secret files', () => {
  it('Read of a secret file is denied, relative, absolute or through a symlink; example files are fine', () => {
    expect(read('.env')).toBe(true);
    expect(read(join(root, '.env.local'))).toBe(true);
    expect(read(join(root, 'certs', 'server.pem'))).toBe(true);
    expect(read(join(root, 'innocent.txt'))).toBe(true);
    for (const name of ['.env.json', '.env.local.yml', 'id_rsa.txt']) expect(read(name)).toBe(true);
    expect(read('.env.example')).toBe(false);
    expect(read('src/app.ts')).toBe(false);
    expect(read('package.json')).toBe(false);
  });

  it('a home path (~) is never read: the tool expands it, the check would not', () => {
    for (const p of ['~/.aws/credentials', '~/.ssh/id_ed25519', '~/notes.txt', '~']) {
      expect(read(p)).toBe(true);
      expect(grep({ path: p })).toBe(true);
      expect(denied(evaluatePreToolUse('Glob', { pattern: '*', path: p }, scan))).toBe(true);
    }
  });

  it('Glob inside a secret path is denied; listing file names is fine', () => {
    expect(denied(evaluatePreToolUse('Glob', { pattern: '*', path: join(root, '.env') }, scan))).toBe(true);
    expect(denied(evaluatePreToolUse('Glob', { pattern: '**/.env*' }, scan))).toBe(false);
  });

  it('Grep takes one ordinary file only', () => {
    expect(grep({ path: 'src/app.ts' })).toBe(false);
    expect(grep({ path: 'package.json' })).toBe(false);
    expect(grep({ path: '.env.example' })).toBe(false);
    // a glob next to a file path changes nothing
    expect(grep({ path: 'src/app.ts', glob: '*' })).toBe(false);
  });

  it('Grep of a folder or without a path is denied, whatever the glob', () => {
    expect(grep({})).toBe(true);
    expect(grep({ glob: '*.ts' })).toBe(true);
    expect(grep({ path: root, glob: '*.json' })).toBe(true);
    expect(grep({ path: 'src', glob: '**/*.{ts,tsx}' })).toBe(true);
    expect(grep({ path: 'src/missing.ts' })).toBe(true);
  });

  it('Grep of a secret file, or a symlink to one, is denied', () => {
    for (const name of ['.env', '.env.json', '.env.local.yml', 'id_rsa.txt', 'innocent.txt']) expect(grep({ path: name })).toBe(true);
  });

  it('Read and Grep stay inside the project (realpath)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'vtl-outside-'));
    writeFileSync(join(outside, 'creds.txt'), 'x');
    symlinkSync(join(outside, 'creds.txt'), join(root, 'link-out.txt'));
    expect(read(join(outside, 'creds.txt'))).toBe(true);
    expect(read('link-out.txt')).toBe(true);
    expect(grep({ path: join(outside, 'creds.txt') })).toBe(true);
    expect(grep({ path: 'link-out.txt' })).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('other agents are not affected', () => {
    expect(read('.env', coder)).toBe(false);
    expect(grep({}, coder)).toBe(false);
  });
});
