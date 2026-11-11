/**
 * Design system mock for the browser build: starts empty; extract and write
 * produce a sample system so every state of the tab can be reviewed.
 */

import type { DesignAPI, DesignDirection, DesignReferenceList, DesignSystemInfo, DesignTokens } from '../../../shared/types';

const sampleTokens: DesignTokens = {
  colors: [
    { name: 'ground', value: '#E8EAE3', role: 'page background' },
    { name: 'panel', value: '#EFF0EA', role: 'raised panels' },
    { name: 'ink', value: '#1C1D19', role: 'text, dark surfaces, structural lines' },
    { name: 'text-muted', value: '#565951', role: 'captions on light' },
    { name: 'hairline', value: '#C6C8BE', role: 'borders and dividers' },
    { name: 'signal', value: '#D6401A', role: 'attention only — never decoration' },
  ],
  fonts: [
    { role: 'text and headings', family: 'Archivo' },
    { role: 'data', family: 'IBM Plex Mono' },
  ],
  radius: [0],
  shadows: false,
  gradients: false,
  spacing: [4, 8, 12, 16, 20, 24, 28],
  bannedPatterns: [{ pattern: 'backdrop-blur', message: 'No glass effects' }],
};

const sampleMarkdown = `# Design system

Instrument-panel style: sharp corners, datasheet structure from hairlines, vermilion only as a signal.

## Colour

| Name | Hex | Role |
|---|---|---|
| ground | #E8EAE3 | page background |
| ink | #1C1D19 | text, dark surfaces |
| signal | #D6401A | attention only |

## Never

- Gradients, glass, soft shadows.
- Vermilion as decoration.
`;

const directions: DesignDirection[] = [
  {
    id: 'a',
    name: 'Lab notebook',
    summary: 'Graph-paper calm for people who read results all day: ruled structure, one ink, data in mono.',
    palette: [
      { name: 'paper', value: '#F3F1E8', role: 'background' },
      { name: 'ink', value: '#1E2430', role: 'text' },
      { name: 'rule', value: '#C9D3DC', role: 'lines' },
      { name: 'mark', value: '#2F6FEB', role: 'selection and links' },
    ],
    fonts: [{ role: 'text', family: 'Source Serif 4' }, { role: 'data', family: 'JetBrains Mono' }],
    principles: ['Numbers are the hero, set in mono and right-aligned', 'Ruled lines, not cards', 'Avoids: dashboards of identical tiles'],
  },
  {
    id: 'b',
    name: 'Signal board',
    summary: 'Transit-signage clarity: big labels, high contrast, colour only for state.',
    palette: [
      { name: 'board', value: '#101418', role: 'background' },
      { name: 'white', value: '#F4F6F8', role: 'text' },
      { name: 'amber', value: '#F2A93B', role: 'warnings' },
      { name: 'go', value: '#2BB673', role: 'success' },
    ],
    fonts: [{ role: 'all text', family: 'Inter Tight' }],
    principles: ['One idea per screen region', 'State is a word plus a colour', 'Avoids: neon glow'],
  },
  {
    id: 'c',
    name: 'Workshop',
    summary: 'Warm, tactile and practical: kraft tones, stencil headings, tools laid out on a bench.',
    palette: [
      { name: 'kraft', value: '#D9C7A7', role: 'background' },
      { name: 'charcoal', value: '#2A2723', role: 'text' },
      { name: 'steel', value: '#5D6B73', role: 'secondary' },
      { name: 'safety', value: '#E4572E', role: 'danger and primary action' },
    ],
    fonts: [{ role: 'headings', family: 'Big Shoulders Display' }, { role: 'text', family: 'IBM Plex Sans' }],
    principles: ['Controls look like tools', 'Labels stamped, not whispered', 'Avoids: cream + terracotta cliché'],
  },
];

let info: DesignSystemInfo = { exists: false, source: 'none', qaMode: 'off', storybook: { detected: false, enabled: false } };

const withSample = (): DesignSystemInfo => ({
  exists: true,
  source: 'app',
  markdownPath: '.vibe-teamlead/design-system.md',
  markdown: sampleMarkdown,
  tokensPath: '.vibe-teamlead/design-tokens.json',
  tokens: sampleTokens,
  qaMode: 'block',
  storybook: { detected: true, dir: 'apps/web', script: 'storybook', enabled: true },
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// References (browser preview): a few digested ones; added ones "digest" after a moment
const swatch = (hex: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="${hex}"/><rect x="16" y="16" width="70" height="10" fill="#888"/><rect x="16" y="34" width="110" height="6" fill="#aaa"/></svg>`)}`;
let refs: DesignReferenceList['references'] = [
  {
    id: 'r1', kind: 'pdf', name: 'Brand guidelines 2026.pdf', source: 'Brand guidelines 2026.pdf', role: 'as-is', addedAt: new Date().toISOString(), status: 'ready', thumbnail: swatch('#EFF0EA'),
    notes: { summary: 'Brand book: logo, colours and type for print and screen.', palette: [{ value: '#1C1D19', role: 'ink' }, { value: '#E8EAE3', role: 'ground' }, { value: '#D6401A', role: 'signal' }], fonts: ['Archivo', 'IBM Plex Mono'], theme: 'light', traits: ['Sharp corners', 'Hairline rules'], takeaways: ['Vermilion only for attention', 'Headings in sentence case'] },
  },
  {
    id: 'r2', kind: 'site', name: 'Linear — linear.app', source: 'https://linear.app', role: 'inspiration', addedAt: new Date().toISOString(), status: 'ready', thumbnail: swatch('#101114'),
    notes: { summary: 'Product site: dark, dense, quiet type.', palette: [{ value: '#101114', share: 0.71, role: 'background' }, { value: '#F7F8F8', share: 0.09, role: 'text' }, { value: '#5E6AD2', share: 0.02, role: 'accent' }], fonts: ['Inter'], theme: 'dark', traits: ['Dense lists', 'Subtle borders'], takeaways: ['Keyboard-first density'] },
  },
  {
    id: 'r3', kind: 'image', name: 'dashboard-moodboard.png', source: 'dashboard-moodboard.png', role: 'inspiration', addedAt: new Date().toISOString(), status: 'ready', thumbnail: swatch('#E8EAE3'),
    notes: { summary: 'Moodboard of instrument panels and lab notebooks.', palette: [{ value: '#E8EAE3', share: 0.58, role: 'background' }, { value: '#1C1D19', share: 0.21, role: 'text' }, { value: '#D6401A', share: 0.03, role: 'accent' }], fonts: [], theme: 'light', traits: ['Datasheet structure', 'Mono numbers'], takeaways: ['Numbers in mono, labels in sans'] },
  },
  {
    id: 'r4', kind: 'tokens', name: 'tokens.json', source: 'tokens.json', role: 'as-is', addedAt: new Date().toISOString(), status: 'ready',
    notes: { summary: 'Token file with 6 colours, fonts Archivo, IBM Plex Mono, 1 radii.', palette: [{ value: '#1C1D19', role: 'ink' }, { value: '#E8EAE3', role: 'ground' }, { value: '#D6401A', role: 'signal' }], fonts: ['Archivo', 'IBM Plex Mono'], traits: ['Radii: 0 px'], takeaways: ['Use these values exactly.'] },
  },
];
const refListeners = new Set<(projectId: string) => void>();
const refList = (): DesignReferenceList => {
  const ready = refs.filter((r) => r.status === 'ready');
  const light = ready.filter((r) => r.notes?.theme === 'light').length;
  const dark = ready.filter((r) => r.notes?.theme === 'dark').length;
  return {
    references: refs,
    summary: { total: refs.length, ready: ready.length, light, dark, sharedColors: ['#1C1D19', '#E8EAE3', '#D6401A'], sharedFonts: ['Archivo'], conflicts: light && dark ? [{ kind: 'theme', light, dark }] : [] },
  };
};
const finishLater = (projectId: string, id: string) =>
  setTimeout(() => {
    refs = refs.map((r) => (r.id === id ? { ...r, status: 'ready', thumbnail: r.kind === 'tokens' ? undefined : swatch('#DFE1D9'), notes: { summary: 'Digested in the browser preview.', palette: [{ value: '#DFE1D9', share: 0.6 }, { value: '#1C1D19', share: 0.2 }], fonts: [], theme: 'light', traits: [], takeaways: [] } } : r));
    for (const cb of refListeners) cb(projectId);
  }, 1500);
let nextRef = 10;


// Design before code (browser preview): a task waiting at its wireframes, with a design drawn next to them
const wire = (title: string, w: number, h: number, cols: number) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;font-family:system-ui;background:#fff;color:#555"><div style="height:44px;border-bottom:1px solid #ccc;display:flex;align-items:center;gap:10px;padding:0 16px"><span style="width:22px;height:22px;background:#ccc"></span><span style="width:90px;height:10px;background:#ccc"></span></div><div style="padding:20px 16px 8px"><div style="width:180px;height:16px;background:#999"></div><p style="font-size:12px;margin:8px 0 0">${title}</p></div><div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px;padding:8px 16px">${Array.from({ length: cols }, (_, i) => `<section style="border:1px dashed #999;padding:8px;display:flex;flex-direction:column;gap:8px"><span style="font-size:11px">Stage ${i + 1}</span><div style="height:46px;border:1px solid #ccc"></div><div style="height:46px;border:1px solid #ccc"></div></section>`).join('')}</div></body></html>`)}`;
const screen = (w: number, h: number, cols: number) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;font-family:system-ui;background:#f8f9f9;color:#181818"><div style="height:48px;background:#fff;border-bottom:1px solid #e3e6e9;display:flex;align-items:center;gap:10px;padding:0 16px"><span style="width:24px;height:24px;border-radius:6px;background:#181818"></span><b>Acme</b></div><h1 style="font-size:22px;margin:16px">Roadmap</h1><div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px;padding:0 16px">${['Planned', 'In progress', 'Shipped'].slice(0, cols).map((s, i) => `<section style="background:${i === 1 ? '#d6e9f9' : '#eef0f2'};border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px"><span style="font-size:12px;font-weight:600">${s}</span><a href="#" style="background:#fff;border-radius:10px;padding:10px;border:1px solid #e3e6e9;color:inherit;text-decoration:none">CSV export of ideas<br><small style="color:#5f6670">▲ 48 votes</small></a></section>`).join('')}</div></body></html>`)}`;
const taskDesignFrames = [
  { file: 'wireframes/roadmap-desktop.html', title: 'Roadmap · desktop', kind: 'wireframe' as const, width: 1280, height: 720, x: 0, y: 0 },
  { file: 'wireframes/roadmap-phone.html', title: 'Roadmap · phone', kind: 'wireframe' as const, width: 390, height: 720, x: 1360, y: 0 },
  { file: 'screens/roadmap-desktop.html', title: 'Roadmap · desktop', kind: 'screen' as const, width: 1280, height: 720, x: 0, y: 1200 },
  { file: 'screens/roadmap-phone.html', title: 'Roadmap · phone', kind: 'screen' as const, width: 390, height: 720, x: 1360, y: 1200 },
];
let taskDesignWaiting: 'wireframes' | 'design' | null = 'wireframes';

export const designMock: DesignAPI = {
  redesignBrief: async () => ({ success: false, error: 'Not available in the browser' }),
  taskDesign: async () => ({
    success: true,
    data: {
      frames: taskDesignWaiting === 'wireframes' ? taskDesignFrames.filter((f) => f.kind === 'wireframe') : taskDesignFrames,
      stage: taskDesignWaiting ?? 'design',
      round: taskDesignWaiting === 'wireframes' ? 1 : 2,
      approved: taskDesignWaiting === 'wireframes' ? {} : { wireframes: new Date().toISOString() },
      waiting: taskDesignWaiting,
      compare: null,
      settings: { mode: 'full', approval: 'owner' },
      frameSrc: {
        'wireframes/roadmap-desktop.html': wire('Planned, in progress and shipped, as columns', 1280, 720, 3),
        'wireframes/roadmap-phone.html': wire('Stages as tabs on a phone', 390, 720, 1),
        'screens/roadmap-desktop.html': screen(1280, 720, 3),
        'screens/roadmap-phone.html': screen(390, 720, 1),
      },
    },
  }),
  library: async () => ({
    success: true,
    data: {
      frames: taskDesignFrames.map((f) => ({ ...f, taskId: '051-roadmap', taskTitle: 'Redesign the public roadmap board', updatedAt: new Date().toISOString() })),
      frameSrc: {
        'wireframes/roadmap-desktop.html': wire('Planned, in progress and shipped, as columns', 1280, 720, 3),
        'wireframes/roadmap-phone.html': wire('Stages as tabs on a phone', 390, 720, 1),
        'screens/roadmap-desktop.html': screen(1280, 720, 3),
        'screens/roadmap-phone.html': screen(390, 720, 1),
      },
    },
  }),
  approveTaskDesign: async (_taskId, stage) => {
    taskDesignWaiting = stage === 'wireframes' ? 'design' : null;
    return { success: true };
  },
  commentTaskDesign: async () => ({ success: true }),
  audit: async () => ({
    success: true,
    data: info.exists && info.tokens
      ? { findings: 37, files: 12, uiFiles: 169, top: [{ file: 'src/components/app-shell.tsx', count: 9, rules: ['off-palette-color', 'shadow'] }, { file: 'src/components/ui/button.tsx', count: 6, rules: ['radius'] }, { file: 'src/app/p/[slug]/page.tsx', count: 5, rules: ['off-palette-color'] }] }
      : null,
  }),
  get: async () => ({ success: true, data: info }),
  save: async (_projectId, content) => {
    info = { ...(info.exists ? info : withSample()), ...(content.markdown !== undefined ? { markdown: content.markdown } : {}), ...(content.tokens ? { tokens: content.tokens } : {}) };
    return { success: true, data: info };
  },
  extract: async () => {
    await delay(600);
    info = { ...withSample(), meta: { writtenAt: new Date().toISOString(), how: 'extract', referenceIds: refs.filter((r) => r.status === 'ready').map((r) => r.id) } };
    return { success: true, data: info };
  },
  propose: async () => {
    await delay(600);
    return { success: true, data: directions };
  },
  write: async (_projectId, _brief, direction) => {
    await delay(600);
    info = { ...withSample(), meta: { writtenAt: new Date().toISOString(), how: 'direction', direction: direction.name, referenceIds: refs.filter((r) => r.status === 'ready').map((r) => r.id) } };
    return { success: true, data: info };
  },
  cancel: async () => ({ success: true }),
  onProgress: () => () => {},
  startStorybook: async () => ({ success: false, error: 'Storybook runs only in the desktop app.' }),
  stopStorybook: async () => ({ success: true }),
  taskStorybookStatus: async () => ({ success: true, data: { worktree: true, detected: true, dir: 'apps/web', script: 'storybook', needsInstall: true, installing: false } }),
  startTaskStorybook: async () => ({ success: false, error: 'Storybook runs only in the desktop app.' }),
  stopTaskStorybook: async () => ({ success: true }),
  listReferences: async () => ({ success: true, data: refList() }),
  pickReferenceFiles: async () => ({ success: true, data: ['/Users/demo/Desktop/inspiration.png'] }),
  pathForFile: (file: File) => `/Users/demo/Downloads/${file.name}`,
  addReferenceFiles: async (projectId, paths, role) => {
    for (const p of paths) {
      const id = `r${nextRef++}`;
      const name = p.split('/').pop() ?? p;
      const kind = /\.pdf$/i.test(name) ? 'pdf' : /\.(json|css|js|ts)$/i.test(name) ? 'tokens' : 'image';
      refs = [...refs, { id, kind, name, source: name, role: kind === 'tokens' ? 'as-is' : (role ?? 'inspiration'), addedAt: new Date().toISOString(), status: 'digesting' }];
      finishLater(projectId, id);
    }
    return { success: true, data: refList() };
  },
  addReferenceUrls: async (projectId, urls, role) => {
    for (const u of urls) {
      const id = `r${nextRef++}`;
      const host = u.replace(/^https?:\/\//, '').split('/')[0];
      refs = [...refs, { id, kind: 'site', name: host, source: u, role: role ?? 'inspiration', addedAt: new Date().toISOString(), status: 'digesting' }];
      finishLater(projectId, id);
    }
    return { success: true, data: refList() };
  },
  setReferenceRole: async (_p, id, role) => {
    refs = refs.map((r) => (r.id === id ? { ...r, role } : r));
    return { success: true, data: refList() };
  },
  removeReference: async (_p, id) => {
    refs = refs.filter((r) => r.id !== id);
    return { success: true, data: refList() };
  },
  retryReference: async (projectId, id) => {
    refs = refs.map((r) => (r.id === id ? { ...r, status: 'digesting', error: undefined } : r));
    finishLater(projectId, id);
    return { success: true, data: refList() };
  },
  onReferencesChanged: (callback) => {
    refListeners.add(callback);
    return () => refListeners.delete(callback);
  },
  pickPackage: async () => ({ success: true, data: '/Users/demo/Downloads/mhp-global-design-system.zip' }),
  inspectPackage: async () => {
    await delay(400);
    return {
      success: true,
      data: {
        name: 'MHP Global',
        components: ['Button', 'Card', 'Input', 'Badge'],
        logos: 3,
        fonts: 4,
        colors: { light: 18, dark: 14 },
        hasTokens: true,
        licenceLine: 'The fonts are commercial: use them within the licence and do not publish the package.',
        ...(info.exists && info.markdownPath ? { replaces: info.markdownPath } : {}),
        skipped: [{ path: 'source/Design.fig', reason: 'type' as const }],
        references: { added: 1, skipped: 0 },
      },
    };
  },
  importPackage: async (_projectId, options) => {
    await delay(600);
    const writtenAt = new Date().toISOString();
    info = {
      ...withSample(),
      meta: { writtenAt, how: 'package', packageName: 'MHP Global', referenceIds: [] },
      package: {
        name: 'MHP Global',
        namespace: 'MHP',
        importedAt: writtenAt,
        dir: '.vibe-teamlead/design/package/mhp-global',
        componentsDir: 'src/components/mhp',
        components: ['Button', 'Card', 'Input', 'Badge'].map((name) => ({ name })),
        logos: [],
        fonts: [],
        themes: options.themes,
        hasDark: true,
      },
    };
    return { success: true, data: info };
  },
  cancelPackage: async () => ({ success: true }),
  setThemes: async (_projectId, themes) => {
    if (info.package) info = { ...info, package: { ...info.package, themes } };
    return { success: true, data: info };
  },
};
