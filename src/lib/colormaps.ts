import type { LayerId } from '../types';

/**
 * Scientific colour maps for the tunnel layers, pre-baked as 256-entry
 * lookup tables of packed little-endian RGBA (0xAABBGGRR) so the renderer
 * writes one Uint32 per pixel.
 *
 * Design rules:
 *  - diverging maps (Cp, vorticity) have a dark NEUTRAL midpoint that sinks
 *    into the carbon UI, and both arms grow monotonically in lightness, so
 *    magnitude always reads as "brighter" whatever the sign;
 *  - the sequential map (|V|) is a single dark → light ramp;
 *  - stops are interpolated in OKLab to avoid muddy mid-tones and banding.
 */

export interface ColorStop {
  t: number;
  hex: string;
}

export interface ColorMap {
  stops: readonly ColorStop[];
  lut: Uint32Array;
  /** CSS `linear-gradient(...)` body (stops only) for legends. */
  css: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(x: number): number {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

function rgbToOklab(rgb: [number, number, number]): [number, number, number] {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb(lab: [number, number, number]): [number, number, number] {
  const l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]) ** 3;
  const m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]) ** 3;
  const s = (lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2]) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Pack an RGB triplet as opaque little-endian RGBA. */
export function packRgb(r: number, g: number, b: number): number {
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

export function buildColorMap(stops: readonly ColorStop[]): ColorMap {
  const labs = stops.map((s) => rgbToOklab(hexToRgb(s.hex)));
  const lut = new Uint32Array(256);
  let seg = 0;
  for (let k = 0; k < 256; k++) {
    const t = k / 255;
    while (seg < stops.length - 2 && t > stops[seg + 1].t) seg++;
    const a = stops[seg];
    const b = stops[seg + 1];
    const f = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-9, b.t - a.t)));
    const la = labs[seg];
    const lb = labs[seg + 1];
    const [r, g, bl] = oklabToRgb([la[0] + (lb[0] - la[0]) * f, la[1] + (lb[1] - la[1]) * f, la[2] + (lb[2] - la[2]) * f]);
    lut[k] = packRgb(r, g, bl);
  }
  // Sample the baked LUT for the legend so CSS matches the canvas exactly.
  const cssStops: string[] = [];
  for (let k = 0; k <= 16; k++) {
    const v = lut[Math.round((k / 16) * 255)];
    cssStops.push(`rgb(${v & 255} ${(v >> 8) & 255} ${(v >> 16) & 255}) ${((k / 16) * 100).toFixed(1)}%`);
  }
  return { stops, lut, css: cssStops.join(', ') };
}

/** Cp — deep blue suction ← neutral → red / yellow overpressure. */
export const PRESSURE_MAP = buildColorMap([
  { t: 0, hex: '#c9f1ff' },
  { t: 0.12, hex: '#5fb4ff' },
  { t: 0.27, hex: '#1f62e0' },
  { t: 0.4, hex: '#152f8f' },
  { t: 0.5, hex: '#12151b' },
  { t: 0.6, hex: '#7a1d12' },
  { t: 0.73, hex: '#d2401a' },
  { t: 0.88, hex: '#f79a1e' },
  { t: 1, hex: '#fff09a' },
]);

/** |V| — stagnation sinks to black, Venturi acceleration glows. */
export const VELOCITY_MAP = buildColorMap([
  { t: 0, hex: '#07080c' },
  { t: 0.18, hex: '#231c52' },
  { t: 0.4, hex: '#27509d' },
  { t: 0.6, hex: '#1f95a4' },
  { t: 0.8, hex: '#63d389' },
  { t: 1, hex: '#f4fcae' },
]);

/**
 * ∇×V — counter-clockwise (teal) vs clockwise (magenta) around a black core.
 * With j pointing down, positive ∂uy/∂x − ∂ux/∂y is CLOCKWISE on screen.
 */
export const VORTICITY_MAP = buildColorMap([
  { t: 0, hex: '#c4fff2' },
  { t: 0.2, hex: '#22cdb8' },
  { t: 0.38, hex: '#0e5f66' },
  { t: 0.5, hex: '#090b0f' },
  { t: 0.62, hex: '#6b1450' },
  { t: 0.8, hex: '#ef3d94' },
  { t: 1, hex: '#ffd2e6' },
]);

/** Carbon tone used for solid bodies. */
export const SOLID_RGB: readonly [number, number, number] = [30, 35, 42];
/** Rim light drawn on the outer edge of rasterised bodies. */
export const EDGE_RGB: readonly [number, number, number] = [138, 148, 160];
/** Fully saturated flow-vis paint. */
export const FLOWVIS_RGB: readonly [number, number, number] = [200, 245, 58];
/** Smoke layer background. */
export const SMOKE_BG_RGB: readonly [number, number, number] = [8, 10, 13];

/** Value ranges mapped onto the LUTs. */
export const CP_SUCTION_MAX = 3.5;
export const CP_PRESSURE_MAX = 1.2;
export const VELOCITY_RATIO_MAX = 2.2;
/** Vorticity that saturates the map, in units of U∞ per cell. */
export const VORTICITY_SAT = 0.22;

export interface LegendSpec {
  title: string;
  css: string;
  ticks: readonly { at: number; label: string }[];
}

export function legendFor(layer: LayerId): LegendSpec | null {
  switch (layer) {
    case 'pressure':
      return {
        title: 'Cp — coefficient de pression',
        css: PRESSURE_MAP.css,
        ticks: [
          { at: 0, label: `−${CP_SUCTION_MAX.toFixed(1)}` },
          { at: 0.5, label: '0' },
          { at: 1, label: `+${CP_PRESSURE_MAX.toFixed(1)}` },
        ],
      };
    case 'velocity':
      return {
        title: '|V| / V∞ — vitesse locale',
        css: VELOCITY_MAP.css,
        ticks: [
          { at: 0, label: '0' },
          { at: 1 / VELOCITY_RATIO_MAX, label: '1' },
          { at: 2 / VELOCITY_RATIO_MAX, label: '2' },
        ],
      };
    case 'vorticity':
      return {
        title: '∇×V — vorticité',
        css: VORTICITY_MAP.css,
        ticks: [
          { at: 0, label: '↺ anti-horaire' },
          { at: 0.5, label: '0' },
          { at: 1, label: 'horaire ↻' },
        ],
      };
    case 'smoke':
      return null;
  }
}
