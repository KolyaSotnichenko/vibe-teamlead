/**
 * Theme constants
 * Color themes for multi-theme support with light/dark mode variants
 */

import type { ColorThemeDefinition } from '../types/settings';

// ============================================
// Color Themes
// ============================================

/**
 * All available color themes with preview colors for the theme selector.
 *
 * A theme is the design system's palette roles with other values, set in
 * renderer/styles/globals.css under `:root[data-theme='<id>']` (the default is `:root`).
 * Light and dark come from the same roles, the signal stays vermilion in every theme, and
 * styles/__tests__/themes.test.ts checks that these previews are the theme's real colours.
 */
export const COLOR_THEMES: ColorThemeDefinition[] = [
  {
    id: 'default',
    name: 'Vibe Teamlead',
    description: 'Instrument-panel palette shared with Meter: ink on ground, vermilion only as a signal',
    previewColors: { bg: '#E8EAE3', fg: '#1C1D19', accent: '#D6401A', darkBg: '#1C1D19', darkFg: '#EFF0EA', darkAccent: '#F0613C' }
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    description: 'Drafting-paper blue: navy ink on a pale blue ground, vermilion only as a signal',
    previewColors: { bg: '#E3E8EF', fg: '#111C2E', accent: '#D6401A', darkBg: '#111C2E', darkFg: '#EDF1F6', darkAccent: '#F0613C' }
  },
  {
    id: 'sand',
    name: 'Sand',
    description: 'Warm paper: brown-black ink on a sand ground, vermilion only as a signal',
    previewColors: { bg: '#ECE6D8', fg: '#211C15', accent: '#D6401A', darkBg: '#211C15', darkFg: '#F3EEE2', darkAccent: '#F0613C' }
  }
];
