/**
 * Design system mock for the browser build: starts empty; extract and write
 * produce a sample system so every state of the tab can be reviewed.
 */

import type { DesignAPI, DesignDirection, DesignSystemInfo, DesignTokens } from '../../../shared/types';

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
};
