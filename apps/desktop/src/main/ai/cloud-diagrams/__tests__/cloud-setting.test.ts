import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> | undefined }));
vi.mock('../../../settings-utils', () => ({ readSettingsFile: () => settings.value }));

import { cloudDiagramsLaunch, isCloudDiagramsEnabled } from '../cloud-setting';
import { architectTaskText } from '../session-input';
import { CLOUD_DESIGN_MARKER } from '../infra-heuristic';

describe('isCloudDiagramsEnabled', () => {
  beforeEach(() => {
    settings.value = {};
  });

  it('is on by default and off only when turned off', () => {
    expect(isCloudDiagramsEnabled()).toBe(true);
    settings.value = { cloudDiagramsEnabled: false };
    expect(isCloudDiagramsEnabled()).toBe(false);
    settings.value = undefined;
    expect(isCloudDiagramsEnabled()).toBe(true);
  });
});

describe('cloudDiagramsLaunch', () => {
  const all = (name: string) => `/bin/${name}`;

  it('is the MCP launch when on and the tools are there', () => {
    expect(cloudDiagramsLaunch(true, all)).toEqual({
      command: { file: '/bin/uvx', args: ['--from', 'terravision[mcp]==0.56.1', 'terravision'] },
      drawFromCode: true,
    });
  });

  it('is nothing when off, or when TerraVision cannot run', () => {
    expect(cloudDiagramsLaunch(false, all)).toBeUndefined();
    expect(cloudDiagramsLaunch(true, (name) => (name === 'dot' ? undefined : `/bin/${name}`))).toBeUndefined();
  });
});

describe('architectTaskText', () => {
  it('reads the spec, the requirements and the task description, and tolerates missing files', () => {
    const spec = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    expect(architectTaskText(spec, 'Deploy to AWS')).toContain('Deploy to AWS');
    writeFileSync(join(spec, 'spec.md'), '# Spec\nHost on Azure');
    mkdirSync(join(spec, 'sub'));
    writeFileSync(join(spec, 'requirements.json'), JSON.stringify({ task_description: 'Use Entra ID' }));
    const text = architectTaskText(spec);
    expect(text).toContain('Host on Azure');
    expect(text).toContain('Use Entra ID');
  });

  it('marks the task Context → Architecture created, so its architect always gets TerraVision', () => {
    const spec = mkdtempSync(join(tmpdir(), 'vtl-spec-'));
    writeFileSync(join(spec, 'task_metadata.json'), JSON.stringify({ cloudArchitectureDesign: true }));
    expect(architectTaskText(spec)).toContain(CLOUD_DESIGN_MARKER);
  });
});
