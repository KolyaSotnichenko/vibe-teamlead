import { describe, expect, it } from 'vitest';

import {
  cloudSafeEnv,
  detectCloudTools,
  installHints,
  TERRAVISION_VERSION,
  terravisionCommand,
} from '../terravision';

const finder = (present: Record<string, string>) => (name: string) => present[name];

describe('detectCloudTools', () => {
  it('is ready with uvx, Graphviz (dot, gvpr) and Git; drawing from code also needs Terraform or OpenTofu', () => {
    const ready = detectCloudTools(finder({ uvx: '/opt/homebrew/bin/uvx', dot: '/b/dot', gvpr: '/b/gvpr', git: '/usr/bin/git' }));
    expect(ready.ready).toBe(true);
    expect(ready.drawFromCode).toBe(false);
    expect(ready.missing).toEqual(['terraform']);

    const full = detectCloudTools(finder({ uvx: '/u/uvx', dot: '/b/dot', gvpr: '/b/gvpr', git: '/g/git', tofu: '/b/tofu' }));
    expect(full.drawFromCode).toBe(true);
    expect(full.engine).toBe('tofu');
    expect(full.missing).toEqual([]);
  });

  it('prefers Terraform when both engines are installed', () => {
    const both = detectCloudTools(finder({ uvx: '/u/uvx', dot: '/d', gvpr: '/g', git: '/git', terraform: '/t', tofu: '/o' }));
    expect(both.engine).toBe('terraform');
  });

  it('accepts an installed terravision instead of uv', () => {
    const r = detectCloudTools(finder({ terravision: '/home/me/.local/bin/terravision', dot: '/d', gvpr: '/g', git: '/git' }));
    expect(r.ready).toBe(true);
    expect(r.missing).not.toContain('uv');
  });

  it('lists everything that is missing and is not ready', () => {
    const none = detectCloudTools(finder({}));
    expect(none.ready).toBe(false);
    expect(none.missing).toEqual(['uv', 'graphviz', 'git', 'terraform']);
    // Graphviz needs both dot and gvpr
    expect(detectCloudTools(finder({ uvx: '/u', dot: '/d', git: '/g' })).missing).toContain('graphviz');
  });
});

describe('terravisionCommand', () => {
  const tools = detectCloudTools(finder({ uvx: '/u/uvx', dot: '/d', gvpr: '/g', git: '/git' }));

  it('runs a pinned TerraVision through uvx, with the MCP extra for the server', () => {
    expect(terravisionCommand(tools, false)).toEqual({ file: '/u/uvx', args: ['--from', `terravision==${TERRAVISION_VERSION}`, 'terravision'] });
    expect(terravisionCommand(tools, true)).toEqual({ file: '/u/uvx', args: ['--from', `terravision[mcp]==${TERRAVISION_VERSION}`, 'terravision'] });
  });

  it('falls back to an installed terravision, and to nothing when not ready', () => {
    const own = detectCloudTools(finder({ terravision: '/bin/terravision', dot: '/d', gvpr: '/g', git: '/git' }));
    expect(terravisionCommand(own, true)).toEqual({ file: '/bin/terravision', args: [] });
    expect(terravisionCommand(detectCloudTools(finder({})), false)).toBeUndefined();
  });
});

describe('installHints', () => {
  it('gives Homebrew lines on macOS and winget lines on Windows', () => {
    const mac = installHints('darwin');
    expect(mac.uv).toBe('brew install uv');
    expect(mac.graphviz).toBe('brew install graphviz');
    expect(mac.terraform).toContain('brew install opentofu');
    const win = installHints('win32');
    expect(win.uv).toBe('winget install --id astral-sh.uv -e');
    expect(win.graphviz).toBe('winget install --id Graphviz.Graphviz -e');
    expect(win.git).toBe('winget install --id Git.Git -e');
    expect(win.terraform).toContain('winget install --id OpenTofu.Tofu -e');
  });
});

describe('cloudSafeEnv', () => {
  const host: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/Users/me',
    LANG: 'en_US.UTF-8',
    HTTPS_PROXY: 'http://proxy:3128',
    AWS_ACCESS_KEY_ID: 'AKIA',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_PROFILE: 'prod',
    AZURE_CLIENT_SECRET: 'x',
    ARM_CLIENT_SECRET: 'x',
    GOOGLE_APPLICATION_CREDENTIALS: '/Users/me/key.json',
    GOOGLE_CREDENTIALS: '{}',
    TF_VAR_db_password: 'p',
    TF_TOKEN_app_terraform_io: 't',
    ANTHROPIC_API_KEY: 'sk-ant',
    GITHUB_TOKEN: 'ghp',
  };

  it('passes no keys or cloud credentials, only what the tools need', () => {
    const env = cloudSafeEnv(host, { platform: 'darwin', sandboxHome: '/tmp/tv/home' });
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(/^(AWS_ACCESS|AWS_SECRET|AWS_PROFILE|AZURE_CLIENT|ARM_|GOOGLE_|TF_VAR_|TF_TOKEN_|ANTHROPIC|GITHUB)/);
    }
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128');
    expect(env.PATH).toContain('/usr/bin');
  });

  it("points home and the clouds' credential files at an empty folder, keeping uv's own cache", () => {
    const env = cloudSafeEnv(host, { platform: 'darwin', sandboxHome: '/tmp/tv/home' });
    expect(env.HOME).toBe('/tmp/tv/home');
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toMatch(/^\/tmp\/tv\/home/);
    expect(env.AWS_CONFIG_FILE).toMatch(/^\/tmp\/tv\/home/);
    expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
    expect(env.AZURE_CONFIG_DIR).toMatch(/^\/tmp\/tv\/home/);
    expect(env.CLOUDSDK_CONFIG).toMatch(/^\/tmp\/tv\/home/);
    expect(env.TF_CLI_CONFIG_FILE).toMatch(/^\/tmp\/tv\/home/);
    expect(env.TF_INPUT).toBe('false');
    expect(env.CHECKPOINT_DISABLE).toBe('1');
    expect(env.UV_CACHE_DIR).toBe('/Users/me/.cache/uv');
    expect(env.UV_PYTHON_INSTALL_DIR).toBe('/Users/me/.local/share/uv/python');
  });

  it('keeps a configured uv cache', () => {
    const env = cloudSafeEnv({ ...host, UV_CACHE_DIR: '/cache/uv' }, { platform: 'darwin', sandboxHome: '/tmp/h' });
    expect(env.UV_CACHE_DIR).toBe('/cache/uv');
  });

  it("on Windows moves the user's profile and AppData too, and keeps uv's folders where they are", () => {
    const win: NodeJS.ProcessEnv = {
      Path: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\me',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      SystemRoot: 'C:\\Windows',
      AWS_SECRET_ACCESS_KEY: 's',
    };
    const env = cloudSafeEnv(win, { platform: 'win32', sandboxHome: 'C:\\Temp\\tv\\home' });
    expect(env.USERPROFILE).toBe('C:\\Temp\\tv\\home');
    expect(env.APPDATA).toMatch(/^C:\\Temp\\tv\\home/);
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.UV_CACHE_DIR).toBe('C:\\Users\\me\\AppData\\Local\\uv\\cache');
    expect(env.UV_PYTHON_INSTALL_DIR).toBe('C:\\Users\\me\\AppData\\Roaming\\uv\\data\\python');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // One PATH key only
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toHaveLength(1);
  });
});
