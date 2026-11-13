import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '', failRename: false }));

vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (state.failRename) throw new Error('the disk went away');
    return actual.renameSync(from, to);
  };
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

import { readSettingsFile, readSettingsFileAsync, writeSettingsFile } from '../settings-utils';

const file = () => join(state.userData, 'settings.json');

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'vtl-settings-'));
  state.failRename = false;
});
afterEach(() => rmSync(state.userData, { recursive: true, force: true }));

// F-003: a write cut short used to leave half a file, read back as "no settings"
describe('settings.json', () => {
  it('is replaced whole: a write that fails leaves the saved settings as they were', () => {
    writeSettingsFile({ language: 'uk', onboardingCompleted: true });
    state.failRename = true;
    expect(() => writeSettingsFile({ language: 'en' })).toThrow();
    state.failRename = false;
    expect(readSettingsFile()).toEqual({ language: 'uk', onboardingCompleted: true });
    expect(readdirSync(state.userData)).toEqual(['settings.json']);
  });

  it('that cannot be read is kept beside it, not taken for an empty one and overwritten', () => {
    writeFileSync(file(), '{"language": "uk", "onboardingComp');
    expect(readSettingsFile()).toBeUndefined();
    expect(readFileSync(`${file()}.corrupt`, 'utf-8')).toBe('{"language": "uk", "onboardingComp');
    expect(existsSync(file())).toBe(false);
    writeSettingsFile({ language: 'en' });
    expect(readFileSync(`${file()}.corrupt`, 'utf-8')).toBe('{"language": "uk", "onboardingComp');
    expect(readSettingsFile()).toEqual({ language: 'en' });
  });

  it('that cannot be read is kept by the async reader too', async () => {
    writeFileSync(file(), 'not json');
    await expect(readSettingsFileAsync()).resolves.toBeUndefined();
    expect(readFileSync(`${file()}.corrupt`, 'utf-8')).toBe('not json');
  });

  it('that is missing is simply no settings', async () => {
    expect(readSettingsFile()).toBeUndefined();
    await expect(readSettingsFileAsync()).resolves.toBeUndefined();
    expect(readdirSync(state.userData)).toEqual([]);
  });
});
