/**
 * Canvas-side mirror of the design tokens declared in `src/index.css`
 * (a 2D context cannot resolve CSS custom properties).
 */
export const TOKENS = {
  carbon950: '#07080a',
  carbon900: '#0c0e11',
  carbon850: '#111418',
  carbon800: '#171b20',
  line: '#232a32',
  lineStrong: '#36404b',
  ink: '#e9edf1',
  inkDim: '#9aa4af',
  inkMute: '#5f6975',
  flowvis: '#c8f53a',
  seriesDf: '#3987e5',
  seriesDrag: '#d95926',
  seriesLd: '#199e70',
  reference: '#b79cff',
  gain: '#2fd27a',
  loss: '#ff5a52',
  warn: '#ffb020',
  fontMono: "'JetBrains Mono Variable', ui-monospace, monospace",
  fontCond: "'Barlow Condensed', 'Barlow', sans-serif",
} as const;
