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

export const designMock: DesignAPI = {
  get: async () => ({ success: true, data: info }),
  save: async (_projectId, content) => {
    info = { ...(info.exists ? info : withSample()), ...(content.markdown !== undefined ? { markdown: content.markdown } : {}), ...(content.tokens ? { tokens: content.tokens } : {}) };
    return { success: true, data: info };
  },
  extract: async () => {
    await delay(600);
    info = withSample();
    return { success: true, data: info };
  },
  propose: async () => {
    await delay(600);
    return { success: true, data: directions };
  },
  write: async () => {
    await delay(600);
    info = withSample();
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
};
