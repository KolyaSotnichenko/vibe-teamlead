import { describe, expect, it } from 'vitest';
import { sampleToolChecks } from '../../../lib/mocks/tools-mock';
import { gateSkipFix, pentestSkipFix, summarize } from '../tool-meta';
import type { ToolCheck } from '../../../../shared/types';

describe('summarize', () => {
  it('reports what each area needs on a fresh Mac', () => {
    expect(summarize(sampleToolChecks)).toEqual([
      { area: 'security_gates', blockers: [{ id: 'osv-scanner', notRunning: false }, { id: 'semgrep', notRunning: false }] },
      { area: 'browser_qa', blockers: [] },
      {
        area: 'security_qa',
        blockers: [
          { id: 'docker', notRunning: true },
          { id: 'strix', notRunning: false },
        ],
      },
    ]);
  });

  it('treats bundled and ready tools as available and omits the bundled area', () => {
    const all: ToolCheck[] = sampleToolChecks.map((t) => ({ ...t, status: t.status === 'bundled' ? 'bundled' : 'ready' }));
    const summary = summarize(all);
    expect(summary.map((s) => s.area)).toEqual(['security_gates', 'browser_qa', 'security_qa']);
    expect(summary.every((s) => s.blockers.length === 0)).toBe(true);
  });
});

describe('gateSkipFix', () => {
  it('matches the reasons gates.ts writes for a missing scanner', () => {
    expect(gateSkipFix('gitleaks', 'gitleaks is not available')).toEqual({ tool: 'gitleaks', kind: 'install', command: 'brew install gitleaks' });
    expect(gateSkipFix('osv-scanner', 'OSV-Scanner is not available')).toEqual({
      tool: 'osv-scanner',
      kind: 'install',
      command: 'brew install osv-scanner',
    });
    expect(gateSkipFix('semgrep', 'Semgrep is not installed')).toEqual({ tool: 'semgrep', kind: 'install', command: 'brew install semgrep' });
  });

  it('gives no fix when the gate was skipped for another reason', () => {
    expect(gateSkipFix('osv-scanner', 'no lockfiles to scan')).toBeNull();
    expect(gateSkipFix('semgrep', 'Semgrep could not fetch its rules (network or registry): Failed to download configuration')).toBeNull();
    expect(gateSkipFix('design', 'design is not available')).toBeNull();
  });
});

describe('pentestSkipFix', () => {
  it('matches the reasons strix.ts writes', () => {
    expect(pentestSkipFix('Strix is not installed (uv tool install strix-agent)')).toEqual({
      tool: 'strix',
      kind: 'install',
      command: 'uv tool install strix-agent',
    });
    expect(pentestSkipFix('Docker is not running')).toEqual({ tool: 'docker', kind: 'start', command: 'open -a Docker' });
  });

  it('gives no fix for an API-key skip or no reason', () => {
    expect(pentestSkipFix('Strix needs an Anthropic API key (a Claude subscription cannot be used for it)')).toBeNull();
    expect(pentestSkipFix(undefined)).toBeNull();
  });
});
