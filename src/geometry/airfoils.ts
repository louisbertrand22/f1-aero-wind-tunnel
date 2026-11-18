/**
 * Parametric F1 test articles and their rasterisation onto the lattice.
 *
 * Coordinates: grid units, x downstream, y DOWNWARD (see `src/types.ts`).
 * Cell (i, j) is a lattice node located at the integer point (i, j); the road
 * surface (half-way bounce-back wall) therefore sits at y = ny − 1.5 and a
 * cell is solid when its node lies inside a polygon.
 *
 * Every wing section is built in a local frame (x along the chord, y toward
 * the camber side) and placed with `placeSection`, which maps the camber side
 * toward the ROAD: the sections are inverted wings, suction surface facing the
 * ground, and a positive incidence lowers the nose / raises the trailing edge.
 */
import type { Bounds, PresetId } from '../types';
import { PRESETS, rideMmPerCell } from './presets';

export interface GeometryInput {
  nx: number;
  ny: number;
  preset: PresetId;
  angleOfAttackDeg: number;
  flapAngleDeg: number;
  rideHeightMm: number;
  /** DRS flap position, 0 = closed … 1 = fully open (continuous). */
  drs: number;
}

export interface GeometryPolygon {
  /** Interleaved x,y in grid coordinates; implicitly closed. */
  points: Float32Array;
  /** True for the DRS flap. */
  movable: boolean;
}

export interface GeometryResult {
  polygons: GeometryPolygon[];
  bounds: Bounds | null;
  /** Reference length (projected total chord / floor length) in cells. */
  refLengthCells: number;
}

const DEG = Math.PI / 180;

/** Columns i < MARGIN_X and i > nx − 1 − MARGIN_X are never solid (inlet / outlet). */
const MARGIN_X = 2;
/** Rows j < MARGIN_Y and j > ny − 1 − MARGIN_Y are never solid (roof / road). */
const MARGIN_Y = 1;
/** Minimum half thickness (cells) kept aft of max thickness so trailing edges stay watertight. */
const MIN_HALF_THICKNESS = 0.7;
/** Minimum clearance between the lowest point of a ground-effect body and the road, cells. */
const MIN_RIDE_CELLS = 3;
/** DRS fully-open flap incidence, degrees. */
const DRS_OPEN_ANGLE_DEG = 3;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/* ------------------------------------------------------------------------- */
/* NACA 4-digit sections                                                      */
/* ------------------------------------------------------------------------- */

/** Half thickness of a closed-trailing-edge NACA 4-digit section at x ∈ [0, 1] (unit chord). */
function nacaHalfThickness(t: number, x: number): number {
  return 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
}

/** Camber line height and slope at x ∈ [0, 1] (unit chord). */
function nacaCamber(m: number, p: number, x: number): { yc: number; dyc: number } {
  if (m === 0 || p <= 0 || p >= 1) return { yc: 0, dyc: 0 };
  if (x < p) {
    return { yc: (m / (p * p)) * (2 * p * x - x * x), dyc: ((2 * m) / (p * p)) * (p - x) };
  }
  const q = (1 - p) * (1 - p);
  return { yc: (m / q) * (1 - 2 * p + 2 * p * x - x * x), dyc: ((2 * m) / q) * (p - x) };
}

/**
 * Closed section contour in the local frame (leading edge at the origin, chord
 * along +x, camber toward +y), cosine-spaced. The contour runs from the
 * trailing edge along the camber-side surface to the leading edge and back
 * along the other surface. `minHalf` (cells) thickens the rear of the section
 * so thin trailing edges survive rasterisation on a coarse lattice.
 */
function nacaSection(m: number, p: number, t: number, chord: number, samples: number, minHalf: number): Float32Array {
  const n = Math.max(8, Math.floor(samples)) - 1;
  const xu = new Float64Array(n + 1);
  const yu = new Float64Array(n + 1);
  const xl = new Float64Array(n + 1);
  const yl = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const x = 0.5 * (1 - Math.cos((Math.PI * i) / n));
    let yt = Math.max(0, nacaHalfThickness(t, x)) * chord;
    if (minHalf > 0 && x > 0.3 && yt < minHalf) yt = minHalf;
    const { yc, dyc } = nacaCamber(m, p, x);
    const theta = Math.atan(dyc);
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    xu[i] = x * chord - yt * s;
    yu[i] = yc * chord + yt * c;
    xl[i] = x * chord + yt * s;
    yl[i] = yc * chord - yt * c;
  }
  const closedTe = minHalf <= 0;
  const count = n + 1 + (closedTe ? n - 1 : n);
  const out = new Float32Array(count * 2);
  let k = 0;
  for (let i = n; i >= 0; i--) {
    out[k++] = xu[i];
    out[k++] = yu[i];
  }
  const last = closedTe ? n - 1 : n;
  for (let i = 1; i <= last; i++) {
    out[k++] = xl[i];
    out[k++] = yl[i];
  }
  return out;
}

/**
 * NACA 4-digit airfoil contour.
 * @param m maximum camber as a fraction of chord (e.g. 0.04)
 * @param p chordwise position of maximum camber as a fraction of chord (e.g. 0.4)
 * @param t maximum thickness as a fraction of chord (e.g. 0.12)
 * @param chord chord length
 * @param samples points per surface (cosine spacing), default 48
 * @returns closed contour, interleaved x,y — leading edge at (0, 0), chord along
 *          +x, y pointing mathematically UP (camber toward +y).
 */
export function naca4(m: number, p: number, t: number, chord: number, samples = 48): Float32Array {
  return nacaSection(m, p, t, chord, samples, 0);
}

/** Local y of the camber-side surface at chordwise distance `xl` (cells). */
function camberSideSurface(m: number, p: number, t: number, chord: number, xl: number): number {
  const x = clamp(xl / chord, 0, 1);
  const { yc, dyc } = nacaCamber(m, p, x);
  return (yc + Math.max(0, nacaHalfThickness(t, x)) * Math.cos(Math.atan(dyc))) * chord;
}

/* ------------------------------------------------------------------------- */
/* Placement helpers                                                          */
/* ------------------------------------------------------------------------- */

interface Vec2 {
  x: number;
  y: number;
}

/** Unit vector along the chord (leading → trailing edge) for an incidence in radians. */
function chordDir(a: number): Vec2 {
  return { x: Math.cos(a), y: -Math.sin(a) };
}

/** Unit vector toward the camber / suction side (road side at zero incidence). */
function camberDir(a: number): Vec2 {
  return { x: Math.sin(a), y: Math.cos(a) };
}

/**
 * Maps a local section onto the grid. The local point (pivotLocalX, 0) lands on
 * (originX, originY); the section is pitched nose-down by `angle` radians.
 */
function placeSection(local: Float32Array, originX: number, originY: number, pivotLocalX: number, angle: number): Float32Array {
  const c = chordDir(angle);
  const n = camberDir(angle);
  const out = new Float32Array(local.length);
  for (let k = 0; k < local.length; k += 2) {
    const dx = local[k] - pivotLocalX;
    const dy = local[k + 1];
    out[k] = originX + dx * c.x + dy * n.x;
    out[k + 1] = originY + dx * c.y + dy * n.y;
  }
  return out;
}

function translate(points: Float32Array, dx: number, dy: number): void {
  for (let k = 0; k < points.length; k += 2) {
    points[k] += dx;
    points[k + 1] += dy;
  }
}

function polygonsBounds(polygons: readonly GeometryPolygon[]): Bounds | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const poly of polygons) {
    const pts = poly.points;
    for (let k = 0; k < pts.length; k += 2) {
      const x = pts[k];
      const y = pts[k + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x0 <= x1 && y0 <= y1 ? { x0, y0, x1, y1 } : null;
}

/**
 * Translates the whole assembly back inside the usable part of the tunnel if a
 * setup pushed it out. The road-side limit is applied last so ground clearance
 * always wins over roof clearance.
 */
function fitInsideTunnel(polygons: GeometryPolygon[], nx: number, bottomLimit: number): void {
  const b = polygonsBounds(polygons);
  if (!b) return;
  const xMin = MARGIN_X + 1;
  const xMax = nx - 2 - MARGIN_X;
  const yMin = MARGIN_Y + 1;
  let dx = 0;
  let dy = 0;
  if (b.x1 > xMax) dx = xMax - b.x1;
  if (b.x0 + dx < xMin) dx = xMin - b.x0;
  if (b.y0 < yMin) dy = yMin - b.y0;
  if (b.y1 + dy > bottomLimit) dy = bottomLimit - b.y1;
  if (dx !== 0 || dy !== 0) for (const poly of polygons) translate(poly.points, dx, dy);
}

interface SectionSpec {
  m: number;
  p: number;
  t: number;
  chord: number;
}

const SECTION_SAMPLES = 48;

function buildSection(spec: SectionSpec): Float32Array {
  return nacaSection(spec.m, spec.p, spec.t, spec.chord, SECTION_SAMPLES, MIN_HALF_THICKNESS);
}

/**
 * Leading-edge position of a slotted flap. The previous element's trailing
 * edge ends up `gap` cells off the flap's suction surface, a few percent of
 * flap chord aft of the flap nose (slight overlap, convergent slot).
 */
function slotLeadingEdge(prevTe: Vec2, flap: SectionSpec, angle: number, gap: number): Vec2 {
  const xl = 0.05 * flap.chord;
  const yl = camberSideSurface(flap.m, flap.p, flap.t, flap.chord, xl) + gap + MIN_HALF_THICKNESS;
  const c = chordDir(angle);
  const n = camberDir(angle);
  return { x: prevTe.x - xl * c.x - yl * n.x, y: prevTe.y - xl * c.y - yl * n.y };
}

/* ------------------------------------------------------------------------- */
/* Presets                                                                    */
/* ------------------------------------------------------------------------- */

function clampToSpec(value: number, range: { min: number; max: number; default: number } | null): number {
  if (!range) return 0;
  return clamp(finiteOr(value, range.default), range.min, range.max);
}

/** Bi-plane rear wing in free air: cambered main plane + slotted DRS flap. */
function buildRearWing(input: GeometryInput): GeometryPolygon[] {
  const { nx, ny } = input;
  const spec = PRESETS.rearWing;
  const aoa = clampToSpec(input.angleOfAttackDeg, spec.aoa) * DEG;
  const flapClosed = clampToSpec(input.flapAngleDeg, spec.flap) * DEG;
  const drs = clamp(finiteOr(input.drs, 0), 0, 1);

  const main: SectionSpec = { m: 0.09, p: 0.45, t: 0.12, chord: 0.2 * nx };
  const flap: SectionSpec = { m: 0.08, p: 0.4, t: 0.15, chord: 0.1 * nx };

  // Main plane pitched about 30 % chord.
  const pivotLocal = 0.3 * main.chord;
  const pivotX = 0.24 * nx + pivotLocal;
  const pivotY = 0.56 * ny;
  const mainPts = placeSection(buildSection(main), pivotX, pivotY, pivotLocal, aoa);
  const cm = chordDir(aoa);
  const mainTe: Vec2 = { x: pivotX + (main.chord - pivotLocal) * cm.x, y: pivotY + (main.chord - pivotLocal) * cm.y };

  // Flap located from the CLOSED setup; the DRS axis (85 % flap chord) is fixed in space.
  const gap = Math.max(3, 0.01 * nx);
  const flapLe = slotLeadingEdge(mainTe, flap, flapClosed, gap);
  const hingeLocal = 0.85 * flap.chord;
  const cf = chordDir(flapClosed);
  const hingeX = flapLe.x + hingeLocal * cf.x;
  const hingeY = flapLe.y + hingeLocal * cf.y;
  const flapOpen = Math.min(flapClosed, DRS_OPEN_ANGLE_DEG * DEG);
  const flapAngle = flapClosed + (flapOpen - flapClosed) * drs;
  const flapPts = placeSection(buildSection(flap), hingeX, hingeY, hingeLocal, flapAngle);

  const polygons: GeometryPolygon[] = [
    { points: mainPts, movable: false },
    { points: flapPts, movable: true },
  ];
  fitInsideTunnel(polygons, nx, ny - 2 - MARGIN_Y);
  return polygons;
}

/** Four-element front wing cascade running in ground effect. */
function buildFrontWing(input: GeometryInput): GeometryPolygon[] {
  const { nx, ny } = input;
  const spec = PRESETS.frontWing;
  const aoaDeg = clampToSpec(input.angleOfAttackDeg, spec.aoa);
  const flapDeg = clampToSpec(input.flapAngleDeg, spec.flap);
  const rideMm = clampToSpec(input.rideHeightMm, spec.rideHeight);

  const sections: SectionSpec[] = [
    { m: 0.07, p: 0.4, t: 0.13, chord: 0.11 * nx },
    { m: 0.08, p: 0.4, t: 0.16, chord: 0.075 * nx },
    { m: 0.08, p: 0.4, t: 0.17, chord: 0.062 * nx },
    { m: 0.08, p: 0.4, t: 0.18, chord: 0.05 * nx },
  ];
  const gap = Math.max(2.3, 0.0075 * nx);
  const lastFlap = sections.length - 1;

  const polygons: GeometryPolygon[] = [];
  let le: Vec2 = { x: 0.22 * nx, y: 0 };
  let prevTe: Vec2 = le;
  for (let k = 0; k < sections.length; k++) {
    const sec = sections[k];
    // Incidence grows progressively along the cascade; the last flap sits at aoa + flap.
    const angle = (aoaDeg + (flapDeg * k) / lastFlap) * DEG;
    if (k > 0) le = slotLeadingEdge(prevTe, sec, angle, gap);
    polygons.push({ points: placeSection(buildSection(sec), le.x, le.y, 0, angle), movable: false });
    const c = chordDir(angle);
    prevTe = { x: le.x + sec.chord * c.x, y: le.y + sec.chord * c.y };
  }

  // Drop the cascade so its lowest point sits at the requested ride height.
  const groundY = ny - 1.5;
  const rideCells = Math.max(MIN_RIDE_CELLS, rideMm / rideMmPerCell('frontWing', nx));
  const b = polygonsBounds(polygons);
  if (b) {
    const dy = groundY - rideCells - b.y1;
    for (const poly of polygons) translate(poly.points, 0, dy);
  }
  fitInsideTunnel(polygons, nx, groundY - MIN_RIDE_CELLS);
  return polygons;
}

/** Flat floor with Venturi inlet, throat and diffuser under a simplified body. */
function buildFloor(input: GeometryInput): GeometryPolygon[] {
  const { nx, ny } = input;
  const spec = PRESETS.floor;
  const rake = clampToSpec(input.angleOfAttackDeg, spec.aoa) * DEG;
  const diffuser = clampToSpec(input.flapAngleDeg, spec.flap) * DEG;
  const rideMm = clampToSpec(input.rideHeightMm, spec.rideHeight);

  const length = 0.56 * nx;
  const xStart = 0.16 * nx;
  const groundY = ny - 1.5;
  const rideCells = Math.max(MIN_RIDE_CELLS, rideMm / rideMmPerCell('floor', nx));
  const throatY = groundY - rideCells;

  // Heights below are measured UP from the throat plane, stations are fractions of length.
  const noseZ = 0.07 * ny; // nose tip height
  const sInlet = 0.22; // end of the Venturi inlet / start of the flat throat
  const sDiff = 0.72; // diffuser kick line
  const blend = 0.06; // curved kick length
  const sBonnet = 0.3; // end of the rounded nose on the upper surface
  const sTail = 0.55; // start of the boat-tail
  const tanD = Math.tan(diffuser);
  const diffuserZ = (s: number): number => {
    const x = (s - sDiff) * length;
    if (x <= 0) return 0;
    const xb = blend * length;
    return x < xb ? (tanD * x * x) / (2 * xb) : tanD * (x - 0.5 * xb);
  };
  const baseZ = Math.max(3, 0.03 * ny); // base thickness at the diffuser exit
  const exitZ = diffuserZ(1) + baseZ;
  const topZ = Math.max(0.22 * ny, exitZ);

  const pts: number[] = [];
  const push = (s: number, z: number): void => {
    pts.push(xStart + s * length, throatY - z);
  };

  // Underside: quarter-ellipse Venturi inlet (vertical tangent at the nose, flat at the throat).
  const NOSE_N = 18;
  for (let k = 0; k <= NOSE_N; k++) {
    const phi = (0.5 * Math.PI * k) / NOSE_N;
    push(sInlet * (1 - Math.cos(phi)), noseZ * (1 - Math.sin(phi)));
  }
  // Flat throat.
  const THROAT_N = 6;
  for (let k = 1; k <= THROAT_N; k++) push(sInlet + ((sDiff - sInlet) * k) / THROAT_N, 0);
  // Diffuser: curved kick then straight ramp.
  const DIFF_N = 16;
  for (let k = 1; k <= DIFF_N; k++) {
    const s = sDiff + ((1 - sDiff) * k) / DIFF_N;
    push(s, diffuserZ(s));
  }
  // Upper surface, walked back toward the nose: boat-tail, bonnet plateau, rounded nose.
  const TAIL_N = 22;
  for (let k = 0; k <= TAIL_N; k++) {
    const u = 1 - k / TAIL_N; // 1 at the exit, 0 at the start of the boat-tail
    // Convex drop (zero slope at the bonnet, steepest at the exit): no dimple once raked.
    push(sTail + (1 - sTail) * u, topZ + (exitZ - topZ) * Math.pow(u, 1.5));
  }
  const ROOF_N = 4;
  for (let k = 1; k < ROOF_N; k++) push(sTail + ((sBonnet - sTail) * k) / ROOF_N, topZ);
  for (let k = NOSE_N; k >= 1; k--) {
    const phi = (0.5 * Math.PI * k) / NOSE_N;
    push(sBonnet * (1 - Math.cos(phi)), noseZ + (topZ - noseZ) * Math.sin(phi));
  }

  // Rake: pitch nose-down about the diffuser kick line, then restore the minimum clearance.
  const points = new Float32Array(pts.length);
  const pivotX = xStart + sDiff * length;
  const cr = Math.cos(rake);
  const sr = Math.sin(rake);
  let lowest = -Infinity;
  for (let k = 0; k < pts.length; k += 2) {
    const dx = pts[k] - pivotX;
    const dy = pts[k + 1] - throatY;
    const x = pivotX + dx * cr + dy * sr;
    const y = throatY - dx * sr + dy * cr;
    points[k] = x;
    points[k + 1] = y;
    if (y > lowest) lowest = y;
  }
  translate(points, 0, throatY - lowest);

  const polygons: GeometryPolygon[] = [{ points, movable: false }];
  fitInsideTunnel(polygons, nx, groundY - MIN_RIDE_CELLS);
  return polygons;
}

/**
 * Builds the vector outline of a preset for the given setup. The `freeform`
 * preset has no outline: its solid mask is sculpted (see `seedFreeform`,
 * `paintBrush`).
 */
export function buildGeometry(input: GeometryInput): GeometryResult {
  let polygons: GeometryPolygon[];
  switch (input.preset) {
    case 'rearWing':
      polygons = buildRearWing(input);
      break;
    case 'frontWing':
      polygons = buildFrontWing(input);
      break;
    case 'floor':
      polygons = buildFloor(input);
      break;
    case 'freeform':
      return { polygons: [], bounds: null, refLengthCells: Math.max(1, 0.1 * input.nx) };
  }
  const bounds = polygonsBounds(polygons);
  return { polygons, bounds, refLengthCells: bounds ? Math.max(1, bounds.x1 - bounds.x0) : 1 };
}

/* ------------------------------------------------------------------------- */
/* Rasterisation & sculpting                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Rasterises the union of the polygons into `out` (cleared first): a cell is 1
 * when its node (i, j) lies inside a polygon (even-odd scanline per polygon).
 * Inlet / outlet columns (i < 2, i > nx − 3) and wall rows (j < 1, j > ny − 2)
 * are never filled.
 */
export function rasterizePolygons(polygons: readonly GeometryPolygon[], nx: number, ny: number, out: Uint8Array): void {
  out.fill(0);
  const iMin = MARGIN_X;
  const iMax = nx - 1 - MARGIN_X;
  const jMin = MARGIN_Y;
  const jMax = ny - 1 - MARGIN_Y;
  const crossings: number[] = [];
  for (const poly of polygons) {
    const pts = poly.points;
    const count = pts.length >> 1;
    if (count < 3) continue;
    let yLo = Infinity;
    let yHi = -Infinity;
    for (let k = 1; k < pts.length; k += 2) {
      if (pts[k] < yLo) yLo = pts[k];
      if (pts[k] > yHi) yHi = pts[k];
    }
    if (!Number.isFinite(yLo) || !Number.isFinite(yHi)) continue;
    const j0 = Math.max(jMin, Math.ceil(yLo));
    const j1 = Math.min(jMax, Math.floor(yHi));
    for (let j = j0; j <= j1; j++) {
      crossings.length = 0;
      let ax = pts[(count - 1) * 2];
      let ay = pts[(count - 1) * 2 + 1];
      for (let v = 0; v < count; v++) {
        const bx = pts[v * 2];
        const by = pts[v * 2 + 1];
        if (ay <= j !== by <= j) crossings.push(ax + ((j - ay) / (by - ay)) * (bx - ax));
        ax = bx;
        ay = by;
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      const row = j * nx;
      for (let c = 0; c + 1 < crossings.length; c += 2) {
        const i0 = Math.max(iMin, Math.ceil(crossings[c]));
        const i1 = Math.min(iMax, Math.floor(crossings[c + 1]));
        for (let i = i0; i <= i1; i++) out[row + i] = 1;
      }
    }
  }
}

/**
 * Sweeps a disc of `radius` cells along the segment (x0, y0) → (x1, y1) and
 * paints (1) or erases (0) every cell node it covers, outside the protected
 * tunnel margins. Returns true when at least one cell changed.
 */
export function paintBrush(mask: Uint8Array, nx: number, ny: number, x0: number, y0: number, x1: number, y1: number, radius: number, erase: boolean): boolean {
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(radius)) return false;
  const r = Math.max(0.5, radius);
  const r2 = r * r;
  const iLo = Math.max(MARGIN_X, Math.ceil(Math.min(x0, x1) - r));
  const iHi = Math.min(nx - 1 - MARGIN_X, Math.floor(Math.max(x0, x1) + r));
  const jLo = Math.max(MARGIN_Y, Math.ceil(Math.min(y0, y1) - r));
  const jHi = Math.min(ny - 1 - MARGIN_Y, Math.floor(Math.max(y0, y1) + r));
  const sx = x1 - x0;
  const sy = y1 - y0;
  const len2 = sx * sx + sy * sy;
  const value = erase ? 0 : 1;
  let changed = false;
  for (let j = jLo; j <= jHi; j++) {
    const row = j * nx;
    for (let i = iLo; i <= iHi; i++) {
      const px = i - x0;
      const py = j - y0;
      const u = len2 > 0 ? clamp((px * sx + py * sy) / len2, 0, 1) : 0;
      const dx = px - u * sx;
      const dy = py - u * sy;
      if (dx * dx + dy * dy > r2) continue;
      if (mask[row + i] !== value) {
        mask[row + i] = value;
        changed = true;
      }
    }
  }
  return changed;
}

/** Initial freeform mask: a circular cylinder that sheds a Von Kármán street right away. */
export function seedFreeform(nx: number, ny: number): Uint8Array {
  const mask = new Uint8Array(nx * ny);
  const cx = 0.24 * nx;
  const cy = 0.5 * ny;
  paintBrush(mask, nx, ny, cx, cy, cx, cy, ny / 11, false);
  return mask;
}

/** Inclusive cell bounds of the solid cells of a mask, or null when it is empty. */
export function maskBounds(mask: Uint8Array, nx: number, ny: number): Bounds | null {
  let x0 = nx;
  let x1 = -1;
  let y0 = ny;
  let y1 = -1;
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      if (mask[row + i] === 0) continue;
      if (i < x0) x0 = i;
      if (i > x1) x1 = i;
      if (j < y0) y0 = j;
      if (j > y1) y1 = j;
    }
  }
  return x1 >= 0 ? { x0, y0, x1, y1 } : null;
}
