import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolveDevTools, resolvePackagedTools } from '../bundled-tools';
import { codegraphLaunch, codegraphMcpServer } from '../codegraph';
import { subtaskCodeContext } from '../../orchestration/code-context';

/** A fake Resources folder holding these files. */
function resources(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'vtl-res-'));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '');
  }
  return root;
}

describe('packaged tools by platform', () => {
  it('macOS: the binaries without extensions, CodeGraph through its shell launcher', () => {
    const res = resources([
      'claude-code/claude',
      'codegraph/bin/codegraph',
      'codegraph/node',
      'scanners/gitleaks',
      'scanners/osv-scanner',
    ]);
    const tools = resolvePackagedTools(res, 'darwin');
    expect(tools.claudeCodeExecutable).toBe(join(res, 'claude-code', 'claude'));
    expect(tools.codegraphBin).toBe(join(res, 'codegraph', 'bin', 'codegraph'));
    expect(tools.lspNode).toBe(join(res, 'codegraph', 'node'));
    expect(tools.gitleaksBin).toBe(join(res, 'scanners', 'gitleaks'));
    expect(tools.osvScannerBin).toBe(join(res, 'scanners', 'osv-scanner'));
  });

  it('Windows: claude.exe, the .exe scanners, CodeGraph and the language servers on its node.exe', () => {
    const res = resources([
      'claude-code/claude.exe',
      'codegraph/bin/codegraph.cmd',
      'codegraph/node.exe',
      'codegraph/lib/dist/bin/codegraph.js',
      'scanners/gitleaks.exe',
      'scanners/osv-scanner.exe',
    ]);
    const tools = resolvePackagedTools(res, 'win32');
    expect(tools.claudeCodeExecutable).toBe(join(res, 'claude-code', 'claude.exe'));
    expect(tools.codegraphBin).toBe(join(res, 'codegraph', 'bin', 'codegraph.cmd'));
    expect(tools.lspNode).toBe(join(res, 'codegraph', 'node.exe'));
    expect(tools.gitleaksBin).toBe(join(res, 'scanners', 'gitleaks.exe'));
    expect(tools.osvScannerBin).toBe(join(res, 'scanners', 'osv-scanner.exe'));
  });

  it('Windows: macOS names are not taken for Windows ones', () => {
    const res = resources(['claude-code/claude', 'codegraph/bin/codegraph', 'codegraph/node', 'scanners/gitleaks']);
    const tools = resolvePackagedTools(res, 'win32');
    expect(tools.claudeCodeExecutable).toBeUndefined();
    expect(tools.codegraphBin).toBeUndefined();
    expect(tools.lspNode).toBeUndefined();
    expect(tools.gitleaksBin).toBeUndefined();
  });

  it('development on Windows looks for the vendor-bin .exe scanners', () => {
    const app = resources(['vendor-bin/gitleaks.exe', 'vendor-bin/osv-scanner.exe']);
    const tools = resolveDevTools(app, 'win32');
    expect(tools.gitleaksBin).toBe(join(app, 'vendor-bin', 'gitleaks.exe'));
    expect(tools.osvScannerBin).toBe(join(app, 'vendor-bin', 'osv-scanner.exe'));
  });
});

describe('codegraphLaunch', () => {
  it('macOS: runs the launcher itself', () => {
    expect(codegraphLaunch('/R/codegraph/bin/codegraph', ['init', '-y', '/p'])).toEqual({
      command: '/R/codegraph/bin/codegraph',
      args: ['init', '-y', '/p'],
    });
  });

  // Node refuses to spawn a .cmd without a shell, so the bundle's own node.exe runs the script the .cmd would
  it('Windows: runs codegraph.js on the bundled node.exe with the flags codegraph.cmd passes', () => {
    expect(codegraphLaunch('C:\\Users\\a\\AppData\\Local\\Programs\\Vibe Teamlead\\resources\\codegraph\\bin\\codegraph.cmd', ['serve', '--mcp'])).toEqual({
      command: 'C:\\Users\\a\\AppData\\Local\\Programs\\Vibe Teamlead\\resources\\codegraph\\node.exe',
      args: [
        '--liftoff-only',
        '--disable-warning=ExperimentalWarning',
        'C:\\Users\\a\\AppData\\Local\\Programs\\Vibe Teamlead\\resources\\codegraph\\lib\\dist\\bin\\codegraph.js',
        'serve',
        '--mcp',
      ],
    });
  });

  it('the MCP server uses it', () => {
    const server = codegraphMcpServer('C:\\R\\codegraph\\bin\\codegraph.cmd', 'C:\\work');
    expect(server.command).toBe('C:\\R\\codegraph\\node.exe');
    expect(server.args).toEqual(['--liftoff-only', '--disable-warning=ExperimentalWarning', 'C:\\R\\codegraph\\lib\\dist\\bin\\codegraph.js', 'serve', '--mcp', '--path', 'C:\\work']);
  });

  it('the coder code context uses it', async () => {
    const project = mkdtempSync(join(tmpdir(), 'vtl-cgctx-'));
    mkdirSync(join(project, '.codegraph'));
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'some code', stderr: '', timedOut: false, aborted: false });
    await subtaskCodeContext({
      bin: 'C:\\R\\codegraph\\bin\\codegraph.cmd',
      projectDir: project,
      subtask: { id: 's1', title: 'Add a thing', files_to_modify: ['src/a.ts'] },
      log: () => undefined,
      run,
      ensureIndex: async () => true,
    });
    // The index is brought up to date, then searched
    expect(run).toHaveBeenCalledTimes(2);
    for (const [i, subcommand] of ['sync', 'explore'].entries()) {
      const [command, args] = run.mock.calls[i];
      expect(command).toBe('C:\\R\\codegraph\\node.exe');
      expect(args.slice(0, 4)).toEqual(['--liftoff-only', '--disable-warning=ExperimentalWarning', 'C:\\R\\codegraph\\lib\\dist\\bin\\codegraph.js', subcommand]);
    }
  });
});
