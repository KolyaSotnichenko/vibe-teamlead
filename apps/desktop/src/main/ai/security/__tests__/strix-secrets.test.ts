import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStrixSecretStore, STRIX_SECRETS_FILE } from '../strix-secrets';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strix-secrets-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const crypto = {
  encrypt: (text: string) => `enc:${Buffer.from(text).toString('base64')}`,
  decrypt: (text: string) => (text.startsWith('enc:') ? Buffer.from(text.slice(4), 'base64').toString() : ''),
};

describe('Strix secret store', () => {
  it('keeps each provider\'s secrets apart, encrypted, and reports only which are saved', () => {
    const store = createStrixSecretStore(dir, crypto);
    expect(store.status()).toEqual({});
    store.save('openrouter', 'apiKey', '  sk-or-SECRET  ');
    store.save('bedrock', 'awsSecretAccessKey', 'aws-SECRET');
    const raw = readFileSync(join(dir, STRIX_SECRETS_FILE), 'utf-8');
    expect(raw).not.toContain('SECRET');
    expect(store.load('openrouter')).toEqual({ apiKey: 'sk-or-SECRET' });
    expect(store.load('deepseek')).toEqual({});
    expect(store.status()).toEqual({ openrouter: { apiKey: true }, bedrock: { awsSecretAccessKey: true } });
    expect(JSON.stringify(store.status())).not.toContain('SECRET');
  });

  it('replaces and clears one secret; the file goes when none is left', () => {
    const store = createStrixSecretStore(dir, crypto);
    store.save('azure', 'azureApiKey', 'a1');
    store.save('azure', 'azureApiKey', 'a2');
    expect(store.load('azure')).toEqual({ azureApiKey: 'a2' });
    store.clear('azure', 'azureApiKey');
    expect(store.load('azure')).toEqual({});
    expect(existsSync(join(dir, STRIX_SECRETS_FILE))).toBe(false);
  });

  it('keeps an unreadable file aside instead of losing it', () => {
    writeFileSync(join(dir, STRIX_SECRETS_FILE), 'garbage');
    const store = createStrixSecretStore(dir, crypto);
    expect(store.load('openai')).toEqual({});
    store.save('openai', 'apiKey', 'k');
    expect(readFileSync(join(dir, `${STRIX_SECRETS_FILE}.unreadable`), 'utf-8')).toBe('garbage');
    expect(store.load('openai')).toEqual({ apiKey: 'k' });
  });

  it('refuses an empty secret and unknown names', () => {
    const store = createStrixSecretStore(dir, crypto);
    expect(() => store.save('openai', 'apiKey', ' ')).toThrow();
    expect(() => store.save('nope' as never, 'apiKey', 'k')).toThrow();
    expect(() => store.save('openai', 'nope' as never, 'k')).toThrow();
  });
});
