import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { designPromptSection, detectStorybook, loadDesignSystem, parseTokens, resolveDesignSystemPaths, saveDesignSystem } from '../design-system';

const project = () => mkdtempSync(path.join(tmpdir(), 'vtl-ds-'));
const tokens = { colors: [{ name: 'ink', value: '#1C1D19' }], fonts: [{ role: 'body', family: 'Archivo' }], radius: [0], shadows: false };

describe('design system files', () => {
  it('finds a repository design system, and its tokens next to it', () => {
    const dir = project();
    mkdirSync(path.join(dir, 'design'));
    writeFileSync(path.join(dir, 'design', 'DESIGN-SYSTEM.md'), '# DS');
    writeFileSync(path.join(dir, 'design', 'design-tokens.json'), JSON.stringify(tokens));
    const info = loadDesignSystem(dir, undefined);
    expect(info).toMatchObject({ exists: true, source: 'repo', markdownPath: 'design/DESIGN-SYSTEM.md', tokensPath: 'design/design-tokens.json', qaMode: 'block' });
    expect(info.tokens?.colors[0].value).toBe('#1C1D19');
  });

  it("prefers the app's own file, then an explicit setting; never a path outside the project", () => {
    const dir = project();
    writeFileSync(path.join(dir, 'DESIGN-SYSTEM.md'), '# repo');
    mkdirSync(path.join(dir, '.vibe-teamlead'));
    writeFileSync(path.join(dir, '.vibe-teamlead', 'design-system.md'), '# app');
    expect(resolveDesignSystemPaths(dir, undefined).markdownPath).toBe('.vibe-teamlead/design-system.md');
    expect(resolveDesignSystemPaths(dir, { designSystemPath: 'DESIGN-SYSTEM.md' }).markdownPath).toBe('DESIGN-SYSTEM.md');
    expect(resolveDesignSystemPaths(dir, { designSystemPath: '../../etc/passwd' }).markdownPath).toBe('.vibe-teamlead/design-system.md');
  });

  it('writes a new design system into .vibe-teamlead and reports QA off when none exists', () => {
    const dir = project();
    expect(loadDesignSystem(dir, undefined)).toMatchObject({ exists: false, source: 'none', qaMode: 'off' });
    saveDesignSystem(dir, undefined, { markdown: '# New', tokens });
    expect(readFileSync(path.join(dir, '.vibe-teamlead', 'design-system.md'), 'utf-8')).toBe('# New\n');
    expect(JSON.parse(readFileSync(path.join(dir, '.vibe-teamlead', 'design-tokens.json'), 'utf-8')).radius).toEqual([0]);
    expect(loadDesignSystem(dir, { designQaMode: 'warn' }).qaMode).toBe('warn');
  });

  it('explains bad tokens instead of failing', () => {
    expect(parseTokens('{').error).toMatch(/not valid JSON/);
    expect(parseTokens(JSON.stringify({ colors: [{ name: 'x', value: 'purple' }] })).error).toMatch(/colors\.0\.value/);
  });

  it('detects Storybook in an app of a monorepo', () => {
    const dir = project();
    mkdirSync(path.join(dir, 'apps', 'web', '.storybook'), { recursive: true });
    writeFileSync(path.join(dir, 'apps', 'web', 'package.json'), JSON.stringify({ scripts: { storybook: 'storybook dev -p 6006' } }));
    expect(detectStorybook(dir, true)).toEqual({ detected: true, dir: 'apps/web', script: 'storybook', enabled: true });
    expect(detectStorybook(project(), false)).toEqual({ detected: false, enabled: false });
  });
});

describe('designPromptSection', () => {
  it('gives builders the system with its tokens, and QA the review instructions', () => {
    const dir = project();
    saveDesignSystem(dir, undefined, { markdown: '# Ink and ground', tokens });
    const info = loadDesignSystem(dir, undefined);
    const builder = designPromptSection(info, { role: 'builder', storybookEnabled: false });
    expect(builder).toContain('<design_system>\n# Ink and ground\n</design_system>');
    expect(builder).toContain('- ink #1C1D19');
    expect(builder).toContain('Shadows: none');
    expect(builder).not.toContain('Design Review');
    const qa = designPromptSection(info, { role: 'qa', storybookEnabled: true, storybook: { detected: false, enabled: true } });
    expect(qa).toContain('"Design Review" table');
    expect(qa).toContain('not set up yet');
  });

  it('without a design system still gives the anti-slop rules', () => {
    const text = designPromptSection(loadDesignSystem(project(), undefined), { role: 'builder', storybookEnabled: false });
    expect(text).toContain('no design system file yet');
    expect(text).toContain('Anti-slop rules');
  });

  describe('design package components', () => {
    const pkg = {
      name: 'MHP', namespace: 'Mhp', importedAt: '2026-11-11', dir: '.vibe-teamlead/design/package/mhp',
      componentsDir: 'src/components/mhp',
      components: [{ name: 'Button', readme: '.vibe-teamlead/design/package/mhp/components/Button/README.md' }, { name: 'Card' }],
      componentCss: '.vibe-teamlead/design/package/mhp/components.css',
      componentTypes: '.vibe-teamlead/design/package/mhp/components.d.ts',
      tokensCss: '.vibe-teamlead/design/package/mhp/tokens.css',
      logos: ['logo.svg'], fonts: ['a.woff2'], themes: 'light' as const, built: ['Button'],
    };
    const withPkg = (over = {}) => ({ ...loadDesignSystem(project(), undefined), package: { ...pkg, ...over } });

    it('tells builders to rebuild components in the project and what is built', () => {
      const text = designPromptSection(withPkg(), { role: 'builder', storybookEnabled: false });
      expect(text).toContain('### Design package components');
      expect(text).toContain('src/components/mhp/Button/');
      expect(text).toContain('never load or run');
      expect(text).toContain('mhp-');
      expect(text).toContain('Built: Button');
      expect(text).toContain('Not built yet: Card');
      expect(text).toContain('.vibe-teamlead/design/package/mhp/logos');
      expect(text).toContain('light theme only');
      expect(text).not.toContain('theme switch');
    });

    it('light-dark asks for both themes and a switch', () => {
      const text = designPromptSection(withPkg({ themes: 'light-dark' }), { role: 'builder', storybookEnabled: false });
      expect(text).toContain('theme switch');
    });

    it('tells QA look-alikes are major issues, and about both themes when light-dark', () => {
      const qa = designPromptSection(withPkg(), { role: 'qa', storybookEnabled: false });
      expect(qa).toContain('look-alike');
      expect(qa).not.toContain('both themes');
      expect(designPromptSection(withPkg({ themes: 'light-dark' }), { role: 'qa', storybookEnabled: false })).toContain('both themes');
    });

    it('gives the package name only inside a data block, and no licence line', () => {
      for (const role of ['builder', 'qa'] as const) {
        const text = designPromptSection(withPkg({ name: 'Zeta Kit', licenceLine: 'Fonts licence: secret' }), { role, storybookEnabled: false });
        const open = text.indexOf('<package_details>');
        const close = text.indexOf('</package_details>');
        expect(open).toBeGreaterThan(-1);
        expect(close).toBeGreaterThan(open);
        const outside = text.slice(0, open) + text.slice(close);
        expect(text.slice(open, close)).toContain('Zeta Kit');
        expect(outside).not.toContain('Zeta Kit');
        expect(text).not.toContain('Fonts licence: secret');
      }
    });

    it('has no package heading without a package', () => {
      expect(designPromptSection(loadDesignSystem(project(), undefined), { role: 'builder', storybookEnabled: false })).not.toContain('Design package components');
    });
  });
});
