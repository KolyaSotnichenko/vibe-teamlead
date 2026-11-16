/**
 * The environment allowlists keep what Windows programs need (SystemRoot,
 * USERPROFILE, APPDATA, TEMP, PATHEXT, …), never credentials, and PATH is
 * stored under one key only (Windows names it Path).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { pickHostEnv, SESSION_HOST_ENV, TOOL_HOST_ENV } from '../ai/claude-code/host-env';
import { codegraphEnv } from '../ai/claude-code/codegraph';
import { buildEnv } from '../ai/claude-code/runner';
import { serverEnv } from '../ai/dev-servers/dev-servers';
import { strixEnv } from '../ai/security/strix';
import { verificationEnv } from '../ai/verification/verify-task';
import { getAugmentedEnv } from '../env-utils';
import { WINDOWS_HOST_ENV } from '../platform/env';

const WINDOWS = {
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\me',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\me',
  USERNAME: 'me',
  NUMBER_OF_PROCESSORS: '8',
};

const saved = { ...process.env };
const withHost = (vars: Record<string, string>) => Object.assign(process.env, vars);
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const keepsWindows = (env: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(WINDOWS)) expect(env[name], name).toBe(value);
};
const onePathKey = (env: Record<string, unknown>) => expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toHaveLength(1);

describe('Windows variables in the allowlists', () => {
  it('the session and tool allowlists include them', () => {
    for (const name of WINDOWS_HOST_ENV) {
      expect(SESSION_HOST_ENV).toContain(name);
      expect(TOOL_HOST_ENV).toContain(name);
    }
  });

  it('pickHostEnv finds a variable under any spelling and returns it under the listed name', () => {
    expect(pickHostEnv(['SystemRoot', 'PATH'], { SYSTEMROOT: 'C:\\Windows', Path: 'C:\\bin' })).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'C:\\bin' });
  });

  it('app checks keep them, drop credentials, and have one PATH', () => {
    const env = verificationEnv({ ...WINDOWS, Path: 'C:\\bin', ANTHROPIC_API_KEY: 'sk-ant-x', GH_TOKEN: 'g' }, {});
    keepsWindows(env);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    onePathKey(env);
    expect(env.PATH).toContain('C:\\bin');
  });

  it('Claude Code sessions keep them, with one PATH', () => {
    withHost(WINDOWS);
    const env = buildEnv({ agentType: 'coder', model: 'claude-sonnet-4-6', auth: { apiKey: 'sk-ant-test' }, claudeConfigDir: '/tmp/vtl' } as never);
    keepsWindows(env);
    onePathKey(env);
  });

  it('dev servers, Strix and CodeGraph keep them', () => {
    withHost(WINDOWS);
    keepsWindows(serverEnv({}));
    keepsWindows(strixEnv({ model: 'claude-sonnet-4-6', apiKey: 'sk-ant-x' }));
    keepsWindows(codegraphEnv());
  });

  it('getAugmentedEnv sets PATH under the key the host uses, never both Path and PATH', () => {
    const path = process.env.PATH ?? '';
    delete process.env.PATH;
    process.env.Path = path;
    const env = getAugmentedEnv();
    onePathKey(env);
    expect(env.Path).toContain(path.split(':')[0]);
  });
});

describe('Storybook tool environment', () => {
  it('has one PATH key when the host names it Path', async () => {
    const { toolEnv } = await import('../design/storybook-service');
    const path = process.env.PATH ?? '';
    delete process.env.PATH;
    process.env.Path = path;
    onePathKey(toolEnv());
  });
});
