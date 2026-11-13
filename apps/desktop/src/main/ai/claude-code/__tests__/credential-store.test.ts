import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '', decryptFails: false }));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`),
    decryptString: (data: Buffer) => {
      if (state.decryptFails) throw new Error('the keychain said no');
      return data.toString().replace(/^sealed:/, '');
    },
  },
}));
vi.mock('../subscription-setting', () => ({ isSubscriptionModeEnabled: () => false }));
vi.mock('../../../settings-utils', () => ({ readSettingsFile: () => ({}) }));

import { clearClaudeKey, loadStoredClaudeKey, resolveClaudeCredentialFor, saveClaudeKey } from '../credential';

const file = () => join(state.userData, 'claude-credential.json');
const aside = () => `${file()}.unreadable`;

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'vtl-credential-'));
  state.decryptFails = false;
});
afterEach(() => rmSync(state.userData, { recursive: true, force: true }));

describe('the stored Claude credential', () => {
  it('keeps both keys: saving one leaves the other', () => {
    saveClaudeKey('sk-ant-api03-key');
    saveClaudeKey('sk-ant-oat01-token');
    expect(loadStoredClaudeKey()).toBe('sk-ant-api03-key');
    expect(resolveClaudeCredentialFor('subscription').key).toBe('sk-ant-oat01-token');
    clearClaudeKey('api');
    expect(loadStoredClaudeKey()).toBeUndefined();
    expect(resolveClaudeCredentialFor('subscription').key).toBe('sk-ant-oat01-token');
  });

  it('is never written as readable text, only the owner may read the file, and no temporary file is left', () => {
    saveClaudeKey('sk-ant-api03-key');
    expect(readFileSync(file(), 'utf-8')).not.toContain('sk-ant-api03-key');
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readdirSync(state.userData)).toEqual(['claude-credential.json']);
  });

  it('removes the file when the last key is cleared', () => {
    saveClaudeKey('sk-ant-api03-key');
    clearClaudeKey('api');
    expect(existsSync(file())).toBe(false);
  });

  // F-029: a file that could not be decrypted was read as "no keys", and the next save put one key over both
  describe('when the saved file cannot be read', () => {
    const unreadable = () => {
      saveClaudeKey('sk-ant-api03-key');
      saveClaudeKey('sk-ant-oat01-token');
      const sealed = readFileSync(file(), 'utf-8');
      state.decryptFails = true;
      return sealed;
    };

    it('saving a key keeps the old file beside the new one instead of losing the other key', () => {
      const sealed = unreadable();
      saveClaudeKey('sk-ant-api03-new');
      expect(readFileSync(aside(), 'utf-8')).toBe(sealed);
      state.decryptFails = false;
      expect(loadStoredClaudeKey()).toBe('sk-ant-api03-new');
    });

    it('clearing a key keeps the old file too', () => {
      const sealed = unreadable();
      clearClaudeKey('api');
      expect(readFileSync(aside(), 'utf-8')).toBe(sealed);
      expect(existsSync(file())).toBe(false);
    });

    it('reading alone changes nothing', () => {
      const sealed = unreadable();
      expect(loadStoredClaudeKey()).toBeUndefined();
      expect(readFileSync(file(), 'utf-8')).toBe(sealed);
      expect(existsSync(aside())).toBe(false);
    });

    it('a file that is not a credential at all is kept aside as well', () => {
      writeFileSync(file(), 'enc:not-base64-json');
      saveClaudeKey('sk-ant-api03-key');
      expect(existsSync(aside())).toBe(true);
      expect(loadStoredClaudeKey()).toBe('sk-ant-api03-key');
    });
  });
});
