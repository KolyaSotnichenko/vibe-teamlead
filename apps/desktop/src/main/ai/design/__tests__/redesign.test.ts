import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DesignFinding } from '../../../../shared/types';
import { auditProjectDesign, matchPackageComponents, redesignBrief } from '../redesign';

const TOKENS = { colors: [{ name: 'ink', value: '#111111' }], fonts: [], radius: [0], shadows: false } as never;

describe('auditProjectDesign: the whole UI against the design system, no model', () => {
  it("checks every tracked UI file, not only a task's new lines", async () => {
    const root = mkdtempSync(join(tmpdir(), 'vtl-audit-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/Card.tsx'), '<div style={{ color: "#ff0000", borderRadius: 12 }} className="shadow-lg" />\n');
    writeFileSync(join(root, 'src/api.ts'), 'const color = "#ff0000";\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    const { findings, uiFiles } = await auditProjectDesign(root, TOKENS);
    expect(uiFiles).toEqual(['src/Card.tsx']);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.file === 'src/Card.tsx')).toBe(true);
  });
});

describe('redesignBrief', () => {
  const finding = (file: string, n: number, rule: DesignFinding['rule'] = 'off-palette-color'): DesignFinding => ({ rule, file, line: n, match: '#ff0000', message: 'Colour outside the palette' });

  it('says what changed, where the code breaks the system, file by file, and how to split the work', () => {
    const text = redesignBrief({
      designSystemPath: '.vibe-teamlead/design-system.md',
      designSystem: '# Design system\n\nInk on ground, radius 0.',
      findings: [finding('src/Card.tsx', 1), finding('src/Card.tsx', 4, 'radius'), finding('src/app/page.tsx', 2)],
      uiFiles: ['src/Card.tsx', 'src/app/page.tsx', 'src/Nav.tsx'],
    });
    expect(text).toMatch(/^# Redesign/m);
    expect(text).toContain('Ink on ground, radius 0.');
    expect(text).toContain('.vibe-teamlead/design-system.md');
    expect(text).toContain('3 places in 2 files');
    expect(text).toMatch(/`src\/Card.tsx`: 2 \(off-palette-color, radius\)/);
    expect(text).toMatch(/shell and navigation/i);
    expect(text).toMatch(/behaviour stays/i);
    expect(text).toMatch(/design check.*clean/i);
  });

  it('caps a long design system and a long list', () => {
    const text = redesignBrief({
      designSystemPath: 'DESIGN.md',
      designSystem: 'x'.repeat(50_000),
      findings: Array.from({ length: 500 }, (_, i) => finding(`src/F${i}.tsx`, 1)),
      uiFiles: Array.from({ length: 500 }, (_, i) => `src/F${i}.tsx`),
    });
    expect(text.length).toBeLessThan(30_000);
    expect(text).toMatch(/and \d+ more files/);
  });

  it('still asks for the redesign when the code already passes the check', () => {
    const text = redesignBrief({ designSystemPath: 'DESIGN.md', designSystem: 'New look.', findings: [], uiFiles: ['src/A.tsx'] });
    expect(text).toMatch(/passes the design check/i);
    expect(text).toMatch(/layout|hierarchy/i);
  });
});

describe('matchPackageComponents: the project\'s look-alikes of package components', () => {
  const pkg = { componentsDir: 'src/components/mhp', components: [{ name: 'Button' }, { name: 'Card' }] };
  const uiFiles = ['src/components/ui/button.tsx', 'src/components/mhp/Button/Button.tsx', 'src/pages/Home.tsx'];

  it('matches by base name, case-insensitively, and ignores the package components dir', () => {
    expect(matchPackageComponents(uiFiles, pkg)).toEqual([{ component: 'Button', files: ['src/components/ui/button.tsx'] }]);
  });

  it('matches a file inside a folder named like the component', () => {
    expect(matchPackageComponents(['src/ui/Card/index.tsx'], pkg)).toEqual([{ component: 'Card', files: ['src/ui/Card/index.tsx'] }]);
  });

  it('puts a rebuild section in the brief only with a package', () => {
    const base = { designSystemPath: 'DESIGN.md', designSystem: '# DS', findings: [], uiFiles };
    const withPkg = redesignBrief({ ...base, package: pkg });
    expect(withPkg).toContain('Package components to rebuild');
    expect(withPkg).toContain('src/components/ui/button.tsx');
    expect(redesignBrief(base)).not.toContain('Package components to rebuild');
  });
});
