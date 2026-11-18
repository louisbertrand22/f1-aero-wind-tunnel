/**
 * Number formatting for the telemetry UI — fr-FR conventions: decimal comma,
 * narrow no-break space as thousands separator, a true minus sign (U+2212)
 * so signed values keep the same width in the tabular mono face.
 */

export const DASH = '—';
export const MINUS = '−';
/** Narrow no-break space (thousands separator, before units). */
export const NNBSP = ' ';

const formatters = new Map<number, Intl.NumberFormat>();

function formatter(digits: number): Intl.NumberFormat {
  let nf = formatters.get(digits);
  if (!nf) {
    nf = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: true });
    formatters.set(digits, nf);
  }
  return nf;
}

/** Rounds to `digits` decimals and normalises −0 to 0. */
function roundTo(value: number, digits: number): number {
  const p = 10 ** digits;
  const r = Math.round(value * p) / p;
  return r === 0 ? 0 : r;
}

/** `12 345,6` — fixed decimals, thin-space grouping, `—` when not finite. */
export function fmt(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return DASH;
  const r = roundTo(value, digits);
  const s = formatter(digits).format(Math.abs(r)).replace(/ /g, NNBSP);
  return r < 0 ? MINUS + s : s;
}

/** `+120`, `−35,2`, `±0` — explicit sign for deltas. */
export function fmtSigned(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return DASH;
  const r = roundTo(value, digits);
  const s = formatter(digits).format(Math.abs(r)).replace(/ /g, NNBSP);
  if (r > 0) return '+' + s;
  if (r < 0) return MINUS + s;
  return '±' + s;
}

/** Fraction → `38,2 %`. */
export function fmtPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return DASH;
  return `${fmt(fraction * 100, digits)}${NNBSP}%`;
}

/** Fraction → `+3,2 %`. */
export function fmtSignedPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return DASH;
  return `${fmtSigned(fraction * 100, digits)}${NNBSP}%`;
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
};

function superscript(n: number): string {
  return String(n)
    .split('')
    .map((c) => SUPERSCRIPT[c] ?? c)
    .join('');
}

export interface SciParts {
  mantissa: string;
  /** e.g. `×10⁶` (empty when the exponent is 0). */
  exponent: string;
}

/** Scientific notation with a fixed exponent: `4,82` + `×10⁶`. */
export function sciParts(value: number, exponent: number, digits = 2): SciParts {
  if (!Number.isFinite(value)) return { mantissa: DASH, exponent: '' };
  return {
    mantissa: fmt(value / 10 ** exponent, digits),
    exponent: exponent === 0 ? '' : `×10${superscript(exponent)}`,
  };
}

/** `4,82 ×10⁶`. */
export function fmtSci(value: number, exponent: number, digits = 2): string {
  const p = sciParts(value, exponent, digits);
  return p.exponent ? `${p.mantissa}${NNBSP}${p.exponent}` : p.mantissa;
}

export interface ValueUnit {
  value: string;
  unit: string;
}

/** Tunnel time: milliseconds below one second, seconds above. */
export function fmtTunnelTime(seconds: number): ValueUnit {
  if (!Number.isFinite(seconds)) return { value: DASH, unit: 'ms' };
  if (Math.abs(seconds) < 1) return { value: fmt(seconds * 1000, 1), unit: 'ms' };
  return { value: fmt(seconds, 3), unit: 's' };
}

/** `14:03:27` local wall-clock time of a `Date.now()` stamp. */
export function fmtClock(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Number of decimals implied by a slider step (0.05 → 2). */
export function digitsOfStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(4, s.length - dot - 1);
}

/** Relative change vs a reference; NaN when the reference is ~0. */
export function relativeDelta(live: number, reference: number): number {
  if (!Number.isFinite(live) || !Number.isFinite(reference) || Math.abs(reference) < 1e-9) return Number.NaN;
  return (live - reference) / Math.abs(reference);
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
