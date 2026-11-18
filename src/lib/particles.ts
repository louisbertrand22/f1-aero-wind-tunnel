/**
 * Lagrangian tracer particles (streaklines).
 *
 * Massless particles are advected through the latest velocity snapshot with a
 * midpoint (RK2) step and drawn as short segments on a persistent, slowly
 * fading layer — the accumulated segments read as streaklines. Particles are
 * re-seeded across the whole veine (recirculation zones stay populated) with
 * a share entering at the inlet.
 */
export class TracerParticles {
  readonly count: number;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly life: Float32Array;
  private nx = 0;
  private ny = 0;
  private seed = 0x2f6e2b1;

  constructor(count: number) {
    this.count = count;
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.life = new Float32Array(count);
  }

  /** xorshift32 — deterministic and allocation-free. */
  private random(): number {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s;
    return (s >>> 0) / 4294967296;
  }

  reset(nx: number, ny: number): void {
    this.nx = nx;
    this.ny = ny;
    for (let k = 0; k < this.count; k++) this.spawn(k, true);
  }

  private spawn(k: number, anywhere: boolean): void {
    const { nx, ny } = this;
    // Mostly uniform re-seeding keeps the streak density even along the veine;
    // the inlet share makes fresh streaks enter with the flow.
    const scatter = anywhere || this.random() < 0.85;
    const x = scatter ? 1 + this.random() * (nx - 3) : 0.5 + this.random() * 1.5;
    const y = 1 + this.random() * (ny - 3);
    this.x[k] = x;
    this.y[k] = y;
    this.px[k] = x;
    this.py[k] = y;
    this.life[k] = 120 + this.random() * 420;
  }

  /**
   * @param steps lattice steps elapsed since the previous call (0 = frozen)
   */
  advect(ux: Float32Array, uy: Float32Array, solid: Uint8Array, nx: number, ny: number, steps: number): void {
    if (nx !== this.nx || ny !== this.ny) this.reset(nx, ny);
    const { x, y, px, py, life } = this;
    const xMax = nx - 1.5;
    const yMax = ny - 1.5;
    for (let k = 0; k < this.count; k++) {
      let cx = x[k];
      let cy = y[k];
      px[k] = cx;
      py[k] = cy;
      if (steps <= 0) continue;

      // Bilinear velocity at the particle.
      let i = cx | 0;
      let j = cy | 0;
      let tx = cx - i;
      let ty = cy - j;
      let a = i + j * nx;
      const u1 = (ux[a] * (1 - tx) + ux[a + 1] * tx) * (1 - ty) + (ux[a + nx] * (1 - tx) + ux[a + nx + 1] * tx) * ty;
      const v1 = (uy[a] * (1 - tx) + uy[a + 1] * tx) * (1 - ty) + (uy[a + nx] * (1 - tx) + uy[a + nx + 1] * tx) * ty;

      // Midpoint evaluation.
      const mx = Math.min(xMax, Math.max(0, cx + 0.5 * steps * u1));
      const my = Math.min(yMax, Math.max(0, cy + 0.5 * steps * v1));
      i = mx | 0;
      j = my | 0;
      tx = mx - i;
      ty = my - j;
      a = i + j * nx;
      const u2 = (ux[a] * (1 - tx) + ux[a + 1] * tx) * (1 - ty) + (ux[a + nx] * (1 - tx) + ux[a + nx + 1] * tx) * ty;
      const v2 = (uy[a] * (1 - tx) + uy[a + 1] * tx) * (1 - ty) + (uy[a + nx] * (1 - tx) + uy[a + nx + 1] * tx) * ty;

      cx += steps * u2;
      cy += steps * v2;
      life[k] -= 1;

      if (life[k] <= 0 || cx < 0.5 || cx > xMax || cy < 0.5 || cy > yMax || solid[Math.round(cx) + Math.round(cy) * nx] !== 0) {
        this.spawn(k, false);
        continue;
      }
      x[k] = cx;
      y[k] = cy;
    }
  }

  /**
   * Append this frame's segments to a path-capable context.
   * Grid coordinate g maps to canvas pixel (g + 0.5) · cell.
   */
  trace(ctx: CanvasRenderingContext2D, cellW: number, cellH: number): void {
    const { x, y, px, py } = this;
    for (let k = 0; k < this.count; k++) {
      const x0 = px[k];
      const y0 = py[k];
      const x1 = x[k];
      const y1 = y[k];
      if (x0 === x1 && y0 === y1) continue;
      ctx.moveTo((x0 + 0.5) * cellW, (y0 + 0.5) * cellH);
      ctx.lineTo((x1 + 0.5) * cellW, (y1 + 0.5) * cellH);
    }
  }
}
