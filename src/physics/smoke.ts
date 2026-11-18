/**
 * Passive smoke dye carried by the LBM velocity field.
 *
 * Three colour channels are advected with a semi-Lagrangian scheme. The
 * back-traced sample uses a Catmull-Rom bicubic kernel clamped to the local
 * extrema (monotone, so the dye stays in [0, 1]) — far less diffusive than a
 * bilinear fetch, which is what keeps the filaments sharp all the way down
 * the test section. No allocation per call (internal double buffer).
 */

/** Nozzle colours, cycled along the rake; chosen to read well on a dark field. */
const NOZZLE_PALETTE: readonly (readonly [number, number, number])[] = [
  [0.3, 0.8, 1.0], // cyan
  [1.0, 0.58, 0.2], // orange
  [0.6, 1.0, 0.35], // lime
  [1.0, 0.38, 0.62], // rose
  [1.0, 0.9, 0.32], // yellow
  [0.68, 0.55, 1.0], // violet
  [0.3, 1.0, 0.8], // aqua
  [0.96, 0.96, 0.98], // white
];

/** First column of the injection strip and its width, in cells. */
const NOZZLE_I0 = 2;
const NOZZLE_WIDTH = 3;
/** Half-height of a nozzle jet, in cells (≈ 2-cell-tall filament). */
const NOZZLE_HALF_HEIGHT = 1;
/** Dye retained per lattice step (≈ 70 % left after crossing a 400-cell tunnel). */
const DECAY_PER_STEP = 0.99992;
const MAX_NOZZLES = 64;

/**
 * Grid row (j, possibly fractional) of the centre of every nozzle of the rake.
 * `center` and `spread` are fractions of the tunnel height (0 = roof, 1 = road).
 */
export function nozzleRows(count: number, center: number, spread: number, ny: number): number[] {
  const n = Math.max(0, Math.min(MAX_NOZZLES, Math.floor(Number.isFinite(count) ? count : 0)));
  const c = Number.isFinite(center) ? center : 0.5;
  const s = Math.max(0, Math.min(1, Number.isFinite(spread) ? spread : 1));
  const lo = 2;
  const hi = Math.max(lo, ny - 3);
  const rows: number[] = [];
  for (let k = 0; k < n; k++) {
    const frac = c - s / 2 + (s * (k + 0.5)) / n;
    const j = frac * ny - 0.5;
    rows.push(Math.min(hi, Math.max(lo, j)));
  }
  return rows;
}

export class SmokeField {
  /** Interleaved RGB in [0, 1], length 3·nx·ny. */
  readonly rgb: Float32Array;
  private readonly nx: number;
  private readonly ny: number;
  private readonly back: Float32Array;
  private readonly nozzleJ = new Float32Array(MAX_NOZZLES);
  private nozzleCount = 0;

  constructor(nx: number, ny: number) {
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 8 || ny < 8) {
      throw new Error(`SmokeField: grille invalide ${nx}×${ny}`);
    }
    this.nx = nx;
    this.ny = ny;
    this.rgb = new Float32Array(nx * ny * 3);
    this.back = new Float32Array(nx * ny * 3);
  }

  /** Lay out the rake (see `nozzleRows`). Nozzle k always keeps palette colour k mod 8. */
  setNozzles(count: number, center: number, spread: number): void {
    const rows = nozzleRows(count, center, spread, this.ny);
    this.nozzleCount = rows.length;
    for (let k = 0; k < rows.length; k++) this.nozzleJ[k] = rows[k];
  }

  clear(): void {
    this.rgb.fill(0);
    this.back.fill(0);
  }

  /**
   * Advance the dye by `dt` lattice steps: semi-Lagrangian advection, slight
   * dissipation, zero inside solids, then injection at the nozzles.
   */
  step(ux: Float32Array, uy: Float32Array, solid: Uint8Array, dt: number, inject: boolean): void {
    const nx = this.nx;
    const ny = this.ny;
    const n = nx * ny;
    if (ux.length !== n || uy.length !== n || solid.length !== n) {
      throw new Error('SmokeField.step: champs de taille incorrecte');
    }
    const src = this.rgb;
    const dst = this.back;
    const h = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const decay = Math.pow(DECAY_PER_STEP, h);
    const xMax = nx - 1;
    const yMax = ny - 1;
    const row3 = nx * 3;

    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const x = row + i;
        const o = x * 3;
        if (solid[x] !== 0) {
          dst[o] = 0;
          dst[o + 1] = 0;
          dst[o + 2] = 0;
          continue;
        }
        // Back-trace the departure point.
        let px = i - ux[x] * h;
        let py = j - uy[x] * h;
        if (!(px > 0)) px = 0;
        else if (px > xMax) px = xMax;
        if (!(py > 0)) py = 0;
        else if (py > yMax) py = yMax;
        let i0 = px | 0;
        let j0 = py | 0;
        if (i0 >= xMax) i0 = xMax - 1;
        if (j0 >= yMax) j0 = yMax - 1;
        const tx = px - i0;
        const ty = py - j0;

        // Central 2×2 footprint.
        const b00 = (i0 + j0 * nx) * 3;
        const b10 = b00 + 3;
        const b01 = b00 + row3;
        const b11 = b01 + 3;
        const r00 = src[b00];
        const g00 = src[b00 + 1];
        const c00 = src[b00 + 2];
        const r10 = src[b10];
        const g10 = src[b10 + 1];
        const c10 = src[b10 + 2];
        const r01 = src[b01];
        const g01 = src[b01 + 1];
        const c01 = src[b01 + 2];
        const r11 = src[b11];
        const g11 = src[b11 + 1];
        const c11 = src[b11 + 2];

        // Clear air: the monotone clamp would return 0 anyway.
        if (r00 + g00 + c00 + r10 + g10 + c10 + r01 + g01 + c01 + r11 + g11 + c11 === 0) {
          dst[o] = 0;
          dst[o + 1] = 0;
          dst[o + 2] = 0;
          continue;
        }

        let vr: number;
        let vg: number;
        let vb: number;
        if (i0 >= 1 && j0 >= 1 && i0 < xMax - 1 && j0 < yMax - 1) {
          // Catmull-Rom weights.
          const tx2 = tx * tx;
          const tx3 = tx2 * tx;
          const wx0 = -0.5 * tx3 + tx2 - 0.5 * tx;
          const wx1 = 1.5 * tx3 - 2.5 * tx2 + 1;
          const wx2 = -1.5 * tx3 + 2 * tx2 + 0.5 * tx;
          const wx3 = 0.5 * tx3 - 0.5 * tx2;
          const ty2 = ty * ty;
          const ty3 = ty2 * ty;
          const wy0 = -0.5 * ty3 + ty2 - 0.5 * ty;
          const wy1 = 1.5 * ty3 - 2.5 * ty2 + 1;
          const wy2 = -1.5 * ty3 + 2 * ty2 + 0.5 * ty;
          const wy3 = 0.5 * ty3 - 0.5 * ty2;

          const qa = b00 - row3 - 3; // row j0-1, column i0-1
          const qb = b00 - 3; // row j0
          const qc = b01 - 3; // row j0+1
          const qd = b01 + row3 - 3; // row j0+2

          vr =
            wy0 * (wx0 * src[qa] + wx1 * src[qa + 3] + wx2 * src[qa + 6] + wx3 * src[qa + 9]) +
            wy1 * (wx0 * src[qb] + wx1 * r00 + wx2 * r10 + wx3 * src[qb + 9]) +
            wy2 * (wx0 * src[qc] + wx1 * r01 + wx2 * r11 + wx3 * src[qc + 9]) +
            wy3 * (wx0 * src[qd] + wx1 * src[qd + 3] + wx2 * src[qd + 6] + wx3 * src[qd + 9]);
          vg =
            wy0 * (wx0 * src[qa + 1] + wx1 * src[qa + 4] + wx2 * src[qa + 7] + wx3 * src[qa + 10]) +
            wy1 * (wx0 * src[qb + 1] + wx1 * g00 + wx2 * g10 + wx3 * src[qb + 10]) +
            wy2 * (wx0 * src[qc + 1] + wx1 * g01 + wx2 * g11 + wx3 * src[qc + 10]) +
            wy3 * (wx0 * src[qd + 1] + wx1 * src[qd + 4] + wx2 * src[qd + 7] + wx3 * src[qd + 10]);
          vb =
            wy0 * (wx0 * src[qa + 2] + wx1 * src[qa + 5] + wx2 * src[qa + 8] + wx3 * src[qa + 11]) +
            wy1 * (wx0 * src[qb + 2] + wx1 * c00 + wx2 * c10 + wx3 * src[qb + 11]) +
            wy2 * (wx0 * src[qc + 2] + wx1 * c01 + wx2 * c11 + wx3 * src[qc + 11]) +
            wy3 * (wx0 * src[qd + 2] + wx1 * src[qd + 5] + wx2 * src[qd + 8] + wx3 * src[qd + 11]);

          // Monotone limiter: stay within the extrema of the central 2×2.
          let lo = r00 < r10 ? r00 : r10;
          let hi = r00 < r10 ? r10 : r00;
          if (r01 < lo) lo = r01;
          else if (r01 > hi) hi = r01;
          if (r11 < lo) lo = r11;
          else if (r11 > hi) hi = r11;
          if (vr < lo) vr = lo;
          else if (vr > hi) vr = hi;

          lo = g00 < g10 ? g00 : g10;
          hi = g00 < g10 ? g10 : g00;
          if (g01 < lo) lo = g01;
          else if (g01 > hi) hi = g01;
          if (g11 < lo) lo = g11;
          else if (g11 > hi) hi = g11;
          if (vg < lo) vg = lo;
          else if (vg > hi) vg = hi;

          lo = c00 < c10 ? c00 : c10;
          hi = c00 < c10 ? c10 : c00;
          if (c01 < lo) lo = c01;
          else if (c01 > hi) hi = c01;
          if (c11 < lo) lo = c11;
          else if (c11 > hi) hi = c11;
          if (vb < lo) vb = lo;
          else if (vb > hi) vb = hi;
        } else {
          // Edge band: plain bilinear.
          const w00 = (1 - tx) * (1 - ty);
          const w10 = tx * (1 - ty);
          const w01 = (1 - tx) * ty;
          const w11 = tx * ty;
          vr = w00 * r00 + w10 * r10 + w01 * r01 + w11 * r11;
          vg = w00 * g00 + w10 * g10 + w01 * g01 + w11 * g11;
          vb = w00 * c00 + w10 * c10 + w01 * c01 + w11 * c11;
        }

        vr *= decay;
        vg *= decay;
        vb *= decay;
        // Drop sub-visible residue so clear air stays exactly clear.
        dst[o] = vr > 1e-4 ? vr : 0;
        dst[o + 1] = vg > 1e-4 ? vg : 0;
        dst[o + 2] = vb > 1e-4 ? vb : 0;
      }
    }

    if (inject) {
      const count = this.nozzleCount;
      const nozzleJ = this.nozzleJ;
      for (let k = 0; k < count; k++) {
        const yc = nozzleJ[k];
        const col = NOZZLE_PALETTE[k % NOZZLE_PALETTE.length];
        const jA = Math.max(0, Math.floor(yc - NOZZLE_HALF_HEIGHT));
        const jB = Math.min(yMax, Math.ceil(yc + NOZZLE_HALF_HEIGHT));
        for (let j = jA; j <= jB; j++) {
          // Soft-edged jet: full strength within the half-height, linear skirt.
          const d = Math.abs(j - yc);
          const a = d <= NOZZLE_HALF_HEIGHT - 0.5 ? 1 : Math.max(0, NOZZLE_HALF_HEIGHT + 0.5 - d);
          if (a <= 0) continue;
          for (let i = NOZZLE_I0; i < NOZZLE_I0 + NOZZLE_WIDTH && i < nx; i++) {
            const x = i + j * nx;
            if (solid[x] !== 0) continue;
            const o = x * 3;
            const r = col[0] * a;
            const g = col[1] * a;
            const b = col[2] * a;
            if (r > dst[o]) dst[o] = r;
            if (g > dst[o + 1]) dst[o + 1] = g;
            if (b > dst[o + 2]) dst[o + 2] = b;
          }
        }
      }
    }

    src.set(dst);
  }
}
