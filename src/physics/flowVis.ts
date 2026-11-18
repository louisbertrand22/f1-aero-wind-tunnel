/**
 * Flow-vis paint.
 *
 * Real flow-vis is a fluorescent paraffin paint brushed on the car before a
 * run: the wall shear drags it along the surface, so attached, fast flow
 * leaves bright streaks while separated or stagnant regions stay wet and dull.
 *
 * In 2D the "surface" is the outline of the body. Each solid cell touching
 * the fluid accumulates paint at a rate proportional to the local wall shear
 * (velocity of the first fluid cell over half a lattice spacing), saturating
 * at 1. The paint then soaks a few cells into the body so it stays visible at
 * screen resolution. Low-shear zones (stall, separation bubbles, stagnation
 * points) therefore remain dark far longer than healthy attached flow.
 */
export class FlowVisPaint {
  readonly nx: number;
  readonly ny: number;
  /** Paint thickness per cell in [0, 1]; non-zero only inside the body. */
  readonly paint: Float32Array;
  /** Accumulation rate per lattice step at unit shear (u_wall = u∞). */
  rate = 0.0009;

  constructor(nx: number, ny: number) {
    this.nx = nx;
    this.ny = ny;
    this.paint = new Float32Array(nx * ny);
  }

  clear(): void {
    this.paint.fill(0);
  }

  /**
   * @param uRef  free-stream lattice velocity used to normalise the shear
   * @param steps lattice steps elapsed since the previous call
   */
  accumulate(ux: Float32Array, uy: Float32Array, solid: Uint8Array, uRef: number, steps: number): void {
    const { nx, ny, paint } = this;
    const inv = 1 / Math.max(1e-6, uRef);
    const k = this.rate * steps;

    // Pass 1 — surface cells: deposit proportional to the neighbouring shear.
    for (let j = 1; j < ny - 1; j++) {
      const row = j * nx;
      for (let i = 1; i < nx - 1; i++) {
        const idx = row + i;
        if (solid[idx] === 0) {
          paint[idx] = 0;
          continue;
        }
        let sum = 0;
        let n = 0;
        const l = idx - 1;
        const r = idx + 1;
        const u = idx - nx;
        const d = idx + nx;
        if (solid[l] === 0) {
          sum += Math.hypot(ux[l], uy[l]);
          n++;
        }
        if (solid[r] === 0) {
          sum += Math.hypot(ux[r], uy[r]);
          n++;
        }
        if (solid[u] === 0) {
          sum += Math.hypot(ux[u], uy[u]);
          n++;
        }
        if (solid[d] === 0) {
          sum += Math.hypot(ux[d], uy[d]);
          n++;
        }
        if (n === 0) continue;
        const shear = Math.min(2.5, (sum / n) * inv);
        // Quadratic response: paint only really moves where the flow scrubs hard.
        const p = paint[idx];
        paint[idx] = p + k * shear * shear * (1 - p);
      }
    }

    // Pass 2 — soak inward so the film is a few cells thick on screen.
    for (let j = 1; j < ny - 1; j++) {
      const row = j * nx;
      for (let i = 1; i < nx - 1; i++) {
        const idx = row + i;
        if (solid[idx] === 0) continue;
        const l = idx - 1;
        const r = idx + 1;
        const u = idx - nx;
        const d = idx + nx;
        if (solid[l] === 0 || solid[r] === 0 || solid[u] === 0 || solid[d] === 0) continue;
        let m = paint[l];
        if (paint[r] > m) m = paint[r];
        if (paint[u] > m) m = paint[u];
        if (paint[d] > m) m = paint[d];
        const soaked = m * 0.72;
        if (soaked > paint[idx]) paint[idx] = soaked;
      }
    }
  }
}
