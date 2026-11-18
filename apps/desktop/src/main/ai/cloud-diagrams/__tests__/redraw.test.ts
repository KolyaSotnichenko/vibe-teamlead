import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RunOptions, RunResult } from '../../../platform/exec';
import { classifyFailure, readCloudArchitecture, redrawCloudArchitecture, terraformChanged, terraformRoot, type RedrawDeps } from '../redraw';
import { detectCloudTools } from '../terravision';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false });
const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr, timedOut: false, aborted: false });

const allTools = detectCloudTools((name) => `/bin/${name}`);

/** A project copy with Terraform in infra/ and a module, made by the fake git clone */
function fakeGit(calls: string[][]): RedrawDeps['git'] {
  return async (args) => {
    calls.push(args);
    if (args[0] === 'clone') {
      const dest = args[args.length - 1];
      mkdirSync(join(dest, 'infra'), { recursive: true });
      mkdirSync(join(dest, 'modules', 'net'), { recursive: true });
      writeFileSync(join(dest, 'infra', 'main.tf'), 'resource "azurerm_resource_group" "rg" {}');
      writeFileSync(join(dest, 'modules', 'net', 'main.tf'), '');
    }
    return { ok: true, stdout: '', raw: '', output: '' };
  };
}

/** TerraVision as it behaves: files in the working directory, named with the provider */
function fakeTerravision(calls: { args: string[]; options: RunOptions }[], graphdata: RunResult = ok()): RedrawDeps['run'] {
  return async (_file, args, options) => {
    calls.push({ args, options });
    const cwd = options.cwd!;
    const command = args[args.indexOf('terravision') + 1];
    if (command === 'graphdata') {
      if (graphdata.code !== 0) return graphdata;
      writeFileSync(join(cwd, 'architecture.tvg.json'), '{"azurerm_resource_group.rg": []}');
    } else if (command === 'draw') {
      const format = args[args.indexOf('--format') + 1];
      writeFileSync(join(cwd, `architecture-azure.${format}`), format === 'svg' ? '<svg/>' : '<mxfile/>');
    } else if (command === 'visualise') {
      writeFileSync(join(cwd, 'architecture-azure.html'), '<html/>');
    }
    return ok();
  };
}

function setup(extra: Partial<RedrawDeps> = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'vtl-proj-'));
  const storeDir = join(projectDir, '.vibe-teamlead', 'cloud-architecture');
  const gitCalls: string[][] = [];
  const runCalls: { args: string[]; options: RunOptions }[] = [];
  const deps: RedrawDeps = {
    git: fakeGit(gitCalls),
    run: fakeTerravision(runCalls),
    tools: allTools,
    platform: 'darwin',
    hostEnv: { PATH: '/usr/bin', HOME: '/Users/me', AWS_SECRET_ACCESS_KEY: 'nope', ANTHROPIC_API_KEY: 'sk' },
    now: () => new Date('2026-11-18T10:00:00Z'),
    ...extra,
  };
  return { projectDir, storeDir, gitCalls, runCalls, deps };
}

describe('terraformChanged', () => {
  it('is true only for .tf, .tf.json and .tfvars files', () => {
    expect(terraformChanged(['src/a.ts', 'README.md'])).toBe(false);
    expect(terraformChanged(['infra/main.tf'])).toBe(true);
    expect(terraformChanged(['envs/prod.tfvars'])).toBe(true);
    expect(terraformChanged(['infra/x.tf.json'])).toBe(true);
  });
});

describe('terraformRoot', () => {
  it('prefers a changed root module over modules/, else the shallowest root', () => {
    expect(terraformRoot(['infra/main.tf', 'modules/net/main.tf'], ['modules/net/main.tf', 'infra/main.tf'])).toBe('infra');
    expect(terraformRoot(['main.tf', 'envs/prod/main.tf'], ['README.md'])).toBe('.');
    expect(terraformRoot(['envs/prod/main.tf', 'envs/dev/main.tf'], ['envs/dev/terraform.tfvars'])).toBe(join('envs', 'dev'));
    expect(terraformRoot([], ['main.tf'])).toBeUndefined();
  });
});

describe('classifyFailure', () => {
  it('tells a want of cloud credentials from other failures', () => {
    expect(classifyFailure('Error: No valid credential sources found')).toBe('needs_cloud_access');
    expect(classifyFailure('building AzureRM Client: please run az login')).toBe('needs_cloud_access');
    expect(classifyFailure('google: could not find default credentials')).toBe('needs_cloud_access');
    expect(classifyFailure('Error: Invalid block definition')).toBe('failed');
  });
});

describe('redrawCloudArchitecture: safety', () => {
  it('refuses a copy with a symbolic link, without running TerraVision', async () => {
    const runCalls: { args: string[]; options: RunOptions }[] = [];
    const { projectDir, storeDir, deps } = setup();
    const git: RedrawDeps['git'] = async (args, cwd) => {
      const result = await deps.git(args, cwd);
      if (args[0] === 'clone') symlinkSync(tmpdir(), join(args[args.length - 1], 'infra', 'up'));
      return result;
    };
    const meta = await redrawCloudArchitecture({ projectDir, commit: 'c11', changedFiles: ['infra/main.tf'], storeDir }, { ...deps, git, run: fakeTerravision(runCalls) });
    expect(runCalls).toEqual([]);
    expect(meta?.lastAttempt).toMatchObject({ status: 'refused' });
    expect(meta?.lastAttempt?.detail).toMatch(/^Couldn't draw from code safely: .*symbolic link/);
  });

  it("refuses code that could run programs, without running TerraVision, and says so", async () => {
    const runCalls: { args: string[]; options: RunOptions }[] = [];
    const { projectDir, storeDir, deps } = setup();
    const git: RedrawDeps['git'] = async (args, cwd) => {
      const result = await deps.git(args, cwd);
      if (args[0] === 'clone') writeFileSync(join(args[args.length - 1], 'infra', 'hook.tf'), 'data "external" "x" { program = ["id"] }');
      return result;
    };
    const meta = await redrawCloudArchitecture({ projectDir, commit: 'c9', changedFiles: ['infra/hook.tf'], storeDir }, { ...deps, git, run: fakeTerravision(runCalls) });
    expect(runCalls).toEqual([]);
    expect(meta?.lastAttempt).toMatchObject({ status: 'refused', commit: 'c9' });
    expect(meta?.lastAttempt?.detail).toMatch(/external/);
  });

  it("makes TerraVision's private folders, plugin cache included, before running it", async () => {
    const seen: string[] = [];
    const { projectDir, storeDir, deps } = setup();
    const run: RedrawDeps['run'] = async (file, args, options) => {
      seen.push(String(existsSync(options.env!.HOME!)), String(existsSync(options.env!.TF_PLUGIN_CACHE_DIR!)));
      return fakeTerravision([])(file, args, options);
    };
    await redrawCloudArchitecture({ projectDir, commit: 'c10', changedFiles: ['infra/main.tf'], storeDir }, { ...deps, run });
    expect(seen.every((v) => v === 'true')).toBe(true);
  });
});

describe('redrawCloudArchitecture', () => {
  it('does nothing at all when the merge changed no Terraform', async () => {
    const { projectDir, storeDir, gitCalls, runCalls, deps } = setup();
    const result = await redrawCloudArchitecture({ projectDir, commit: 'abc1234', changedFiles: ['src/app.ts'], storeDir }, deps);
    expect(result).toBeUndefined();
    expect(gitCalls).toEqual([]);
    expect(runCalls).toEqual([]);
    expect(existsSync(storeDir)).toBe(false);
  });

  it('draws from a clean copy of the commit, without keys, and keeps SVG, draw.io, HTML and the graph', async () => {
    const { projectDir, storeDir, gitCalls, runCalls, deps } = setup();
    const meta = await redrawCloudArchitecture(
      { projectDir, commit: 'abc1234def', changedFiles: ['infra/main.tf'], storeDir, taskId: 't1', taskTitle: 'Add storage' },
      deps,
    );
    expect(gitCalls[0].slice(0, 3)).toEqual(['clone', '-q', '--no-hardlinks']);
    expect(gitCalls[1]).toEqual(['checkout', '-q', '--detach', 'abc1234def']);
    const commands = runCalls.map((c) => c.args[c.args.indexOf('terravision') + 1]);
    expect(commands).toEqual(['graphdata', 'draw', 'draw', 'visualise']);
    // Terraform runs once (graphdata, visualise); the pictures come from the graph
    const graphdata = runCalls[0];
    expect(graphdata.args.join(' ')).toContain('--source');
    expect(graphdata.args[graphdata.args.indexOf('--source') + 1]).toMatch(/copy[\\/]infra$/);
    for (const call of runCalls) {
      expect(call.options.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(call.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(call.options.env?.HOME).not.toBe('/Users/me');
      expect(call.options.timeoutMs).toBeGreaterThan(0);
      expect(call.options.killGroup).toBe(true);
    }
    expect(meta?.lastAttempt).toMatchObject({ status: 'drawn', commit: 'abc1234def' });
    expect(meta?.drawn).toMatchObject({ commit: 'abc1234def', taskId: 't1', taskTitle: 'Add storage', source: 'infra', drawnAt: '2026-11-18T10:00:00.000Z' });
    expect(meta?.drawn?.files).toEqual({ svg: 'architecture-azure.svg', drawio: 'architecture-azure.drawio', html: 'architecture-azure.html', graph: 'architecture.tvg.json' });
    expect(readFileSync(join(storeDir, 'latest', 'architecture-azure.svg'), 'utf-8')).toBe('<svg/>');
    expect(readCloudArchitecture(storeDir)).toEqual(meta);
  });

  it('notes missing tools quietly and keeps the last drawing', async () => {
    const { projectDir, storeDir, deps } = setup();
    await redrawCloudArchitecture({ projectDir, commit: 'c1', changedFiles: ['infra/main.tf'], storeDir }, deps);
    const noTerraform = detectCloudTools((name) => (name === 'terraform' || name === 'tofu' ? undefined : `/bin/${name}`));
    const meta = await redrawCloudArchitecture({ projectDir, commit: 'c2', changedFiles: ['infra/main.tf'], storeDir }, { ...deps, tools: noTerraform });
    expect(meta?.lastAttempt).toMatchObject({ status: 'unavailable', commit: 'c2', missing: ['terraform'] });
    expect(meta?.drawn?.commit).toBe('c1');
  });

  it("says it couldn't draw without cloud access when the plan wants credentials", async () => {
    const runCalls: { args: string[]; options: RunOptions }[] = [];
    const { projectDir, storeDir, deps } = setup();
    const meta = await redrawCloudArchitecture(
      { projectDir, commit: 'c3', changedFiles: ['infra/main.tf'], storeDir },
      { ...deps, run: fakeTerravision(runCalls, fail('Error: No valid credential sources found for AWS Provider')) },
    );
    expect(meta?.lastAttempt).toMatchObject({ status: 'needs_cloud_access', commit: 'c3' });
    expect(meta?.drawn).toBeUndefined();
    expect(runCalls).toHaveLength(1);
  });

  it('never throws: a broken clone is a failed attempt', async () => {
    const { projectDir, storeDir, deps } = setup({ git: async () => ({ ok: false, stdout: '', raw: '', output: 'fatal: bad object' }) });
    const meta = await redrawCloudArchitecture({ projectDir, commit: 'c4', changedFiles: ['main.tf'], storeDir }, deps);
    expect(meta?.lastAttempt).toMatchObject({ status: 'failed', commit: 'c4' });
  });
});
