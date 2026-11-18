/**
 * 2D Lattice Boltzmann solver — D2Q9, BGK collision with a Smagorinsky
 * sub-grid closure (local relaxation time), written for throughput: flat
 * Float32Array populations (structure of arrays), a fused pull-stream +
 * collide loop, no allocation and no closure in the hot path.
 *
 * Conventions (see src/types.ts): cell (i, j), i downstream, j DOWNWARD,
 * idx = i + j·nx, lattice units (dx = dt = 1, cs² = 1/3, ρ₀ = 1).
 *
 * Lattice directions (ex, ey):
 *   0 (0,0)  1 (1,0)  2 (0,1)  3 (-1,0)  4 (0,-1)
 *   5 (1,1)  6 (-1,1) 7 (-1,-1) 8 (1,-1)
 *
 * Boundary conditions:
 *  - inlet  (i = 0)      : equilibrium at the prescribed velocity profile with
 *                          the density extrapolated from the first fluid column
 *                          (lets upstream-travelling pressure waves leave);
 *  - outlet (i = nx-1)   : zero-gradient extrapolation re-anchored to ρ = 1,
 *                          behind a viscous sponge that dissolves the wake
 *                          before it reaches the boundary;
 *  - roof   (j = 0)      : free-slip (specular reflection, wall at j = -½);
 *  - road   (j = ny-1)   : free-slip, or rolling road = half-way bounce-back
 *                          with the momentum correction of a wall moving at
 *                          the inlet speed (wall at j = ny-½);
 *  - body   (solid = 1)  : half-way bounce-back; aerodynamic loads by momentum
 *                          exchange over every fluid→body link.
 */

export type BottomBoundary = 'movingWall' | 'freeSlip';

export interface ForceSample {
  /** Drag, lattice units, MEAN per step since the previous takeForces(). */
  fx: number;
  /** Vertical load, positive toward the road (downforce). */
  fy: number;
  /** Σ x_link · Fy_link (mean per step) → centre of pressure x = xFy / fy. */
  xFy: number;
  /** Σ y_link · Fx_link (mean per step). */
  yFx: number;
  /** Number of steps averaged. */
  steps: number;
}

const W0 = 4 / 9;
const W1 = 1 / 9;
const W2 = 1 / 36;

const EX = Int8Array.of(0, 1, 0, -1, 0, 1, -1, -1, 1);
const EY = Int8Array.of(0, 0, 1, 0, -1, 1, 1, -1, -1);
const OPP = Uint8Array.of(0, 3, 4, 1, 2, 7, 8, 5, 6);
/** Direction obtained by flipping ey (specular reflection on a horizontal wall). */
const MIRROR_Y = Uint8Array.of(0, 1, 4, 3, 2, 8, 7, 6, 5);
const WQ = Float64Array.of(W0, W1, W1, W1, W1, W2, W2, W2, W2);

/** Smagorinsky constant. */
const CS_SMAG = 0.16;
/** 18·√2·Cs² — prefactor of the non-equilibrium stress norm in τ_eff. */
const SMAG_K = 18 * Math.SQRT2 * CS_SMAG * CS_SMAG;

const NU_MIN = 0.002;
const NU_MAX = 0.2;

/** Safety limiter: lattice speed above which the velocity is rescaled. */
const U_LIMIT = 0.35;
const U_LIMIT2 = U_LIMIT * U_LIMIT;
const RHO_MIN = 0.5;
const RHO_MAX = 2.0;

/** Sponge layer in front of the outlet. */
const SPONGE_COLUMNS = 24;
const SPONGE_TAU_BOOST = 1.0;

/** Lattice speed of sound. */
const CS = Math.sqrt(1 / 3);
/** Per-step relaxation of the outlet density toward 1 (soft pressure anchor). */
const OUTLET_RELAX = Number(process.env.OR ?? 0.004);
/** Per-step relaxation of the inlet reference density toward the inlet mean. */
const INLET_RELAX = Number(process.env.IR ?? 1 / 2500);

/** Cell classification for the hot loop. */
const FLAG_FAST = 0; // interior fluid, no wall in the stencil
const FLAG_SOLID = 1;
const FLAG_SLOW = 2; // fluid touching a body, the roof or the road

/** Synthetic dirty-air modes. */
const DIRTY_MODES = 10;
const DIRTY_DEFICIT = 0.3;
const DIRTY_MODE_AMPLITUDE = 0.3 / Math.sqrt(DIRTY_MODES / 2);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LbmSolver {
  readonly nx: number;
  readonly ny: number;
  readonly size: number;
  /** Macroscopic fields, refreshed by every step (velocity is 0 inside solids). */
  readonly rho: Float32Array;
  readonly ux: Float32Array;
  readonly uy: Float32Array;
  /** 0 = fluid, 1 = body. */
  readonly solid: Uint8Array;
  stepCount = 0;

  /** Post-collision populations of the previous step (read side). */
  private f: Float32Array[];
  /** Write side; swapped with `f` after every step. */
  private g: Float32Array[];
  private readonly flags: Uint8Array;
  private readonly prevSolid: Uint8Array;
  /** Base relaxation time per column (molecular viscosity + outlet sponge). */
  private readonly tauCol: Float32Array;
  /** Inlet velocity profile for the current step. */
  private readonly inU: Float32Array;
  private readonly inV: Float32Array;
  /** Scratch for the generic (boundary) streaming path. */
  private readonly fin = new Float64Array(9);

  private nu = 0.01;
  private u0 = 0.08;
  private bottom: BottomBoundary = 'freeSlip';
  /** Slow-tracking reference density of the characteristic inlet. */
  private rhoInlet = 1;

  // Dirty-air generator state.
  private dirty = 0;
  private dirtyTravel = 0;
  private inletProfileClean = false;
  private readonly modeKx = new Float64Array(DIRTY_MODES);
  private readonly modePhase = new Float64Array(DIRTY_MODES);
  private readonly modeU = new Float64Array(DIRTY_MODES);
  private readonly modeV = new Float64Array(DIRTY_MODES);
  private readonly modeCt = new Float64Array(DIRTY_MODES);
  private readonly modeSt = new Float64Array(DIRTY_MODES);
  private readonly modeSinY: Float32Array;
  private readonly modeCosY: Float32Array;
  private readonly wallDamp: Float32Array;

  // Momentum-exchange accumulators (sums over steps since takeForces()).
  private accFx = 0;
  private accFy = 0;
  private accXFy = 0;
  private accYFx = 0;
  private accSteps = 0;

  /** Cells touched by the velocity / density limiter during the last step. */
  private limiterHits = 0;

  constructor(nx: number, ny: number) {
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 8 || ny < 8) {
      throw new Error(`LbmSolver: grille invalide ${nx}×${ny}`);
    }
    this.nx = nx;
    this.ny = ny;
    const n = nx * ny;
    this.size = n;
    this.rho = new Float32Array(n);
    this.ux = new Float32Array(n);
    this.uy = new Float32Array(n);
    this.solid = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.prevSolid = new Uint8Array(n);
    this.tauCol = new Float32Array(nx);
    this.inU = new Float32Array(ny);
    this.inV = new Float32Array(ny);
    this.f = [];
    this.g = [];
    for (let q = 0; q < 9; q++) {
      this.f.push(new Float32Array(n));
      this.g.push(new Float32Array(n));
    }

    // Divergence-free synthetic eddies: ψ = Σ A·cos(kx(x − U t) + φ)·cos(ky y + θ).
    this.modeSinY = new Float32Array(DIRTY_MODES * ny);
    this.modeCosY = new Float32Array(DIRTY_MODES * ny);
    this.wallDamp = new Float32Array(ny);
    const rand = mulberry32(0x5eedf1);
    for (let m = 0; m < DIRTY_MODES; m++) {
      const lambdaX = ny * (0.22 + 1.0 * rand());
      const lambdaY = ny * (0.2 + 0.7 * rand());
      const kx = (2 * Math.PI) / lambdaX;
      const ky = (2 * Math.PI) / lambdaY;
      const k = Math.hypot(kx, ky);
      const theta = 2 * Math.PI * rand();
      this.modeKx[m] = kx;
      this.modePhase[m] = 2 * Math.PI * rand();
      this.modeU[m] = (-DIRTY_MODE_AMPLITUDE * ky) / k;
      this.modeV[m] = (DIRTY_MODE_AMPLITUDE * kx) / k;
      for (let j = 0; j < ny; j++) {
        this.modeSinY[m * ny + j] = Math.sin(ky * j + theta);
        this.modeCosY[m * ny + j] = Math.cos(ky * j + theta);
      }
    }
    for (let j = 0; j < ny; j++) {
      const d = Math.min(j + 0.5, ny - 0.5 - j);
      this.wallDamp[j] = Math.min(1, d / 10);
    }

    this.updateTau();
    this.rebuildFlags();
    this.reset();
  }

  /** Kinematic viscosity in lattice units; τ = 3ν + ½. */
  setViscosity(nuLattice: number): void {
    const nu = Number.isFinite(nuLattice) ? nuLattice : this.nu;
    this.nu = Math.min(NU_MAX, Math.max(NU_MIN, nu));
    this.updateTau();
  }

  /** Target free-stream lattice velocity, applied as-is at the inlet. */
  setInletVelocity(u: number): void {
    const v = Number.isFinite(u) ? u : this.u0;
    this.u0 = Math.min(0.2, Math.max(0, v));
    this.inletProfileClean = false;
  }

  get inletVelocity(): number {
    return this.u0;
  }

  setBottomBoundary(mode: BottomBoundary): void {
    this.bottom = mode;
  }

  /** 0 = clean air, 0..1 = synthetic turbulent wake fed through the inlet. */
  setDirtyAir(intensity: number): void {
    const v = Number.isFinite(intensity) ? intensity : 0;
    this.dirty = Math.min(1, Math.max(0, v));
    this.inletProfileClean = false;
  }

  /**
   * Replace the body mask. Cells that become fluid restart from a resting
   * equilibrium at the mean density of their fluid neighbours; cells that
   * become solid are simply flagged.
   */
  setSolid(mask: Uint8Array): void {
    const { nx, ny, size, solid, prevSolid, rho, ux, uy, f, g } = this;
    if (mask.length !== size) {
      throw new Error(`LbmSolver.setSolid: masque de ${mask.length} cellules, ${size} attendues`);
    }
    prevSolid.set(solid);
    let changed = false;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const x = row + i;
        // Inlet and outlet columns always stay open.
        const m = mask[x] !== 0 && i > 0 && i < nx - 1 ? 1 : 0;
        if (m !== solid[x]) {
          solid[x] = m;
          changed = true;
        }
      }
    }
    if (!changed) return;

    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const x = row + i;
        const now = solid[x];
        if (now === prevSolid[x]) continue;
        let r = 1;
        if (now === 0) {
          // Freed cell: borrow the density of neighbours that were and remain fluid.
          let sum = 0;
          let cnt = 0;
          for (let q = 1; q < 9; q++) {
            const ni = i + EX[q];
            const nj = j + EY[q];
            if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) continue;
            const xn = ni + nj * nx;
            if (prevSolid[xn] === 0 && solid[xn] === 0) {
              sum += rho[xn];
              cnt++;
            }
          }
          if (cnt > 0 && Number.isFinite(sum)) r = sum / cnt;
        }
        for (let q = 0; q < 9; q++) {
          f[q][x] = WQ[q] * r;
          g[q][x] = WQ[q] * r;
        }
        rho[x] = r;
        ux[x] = 0;
        uy[x] = 0;
      }
    }
    this.rebuildFlags();
  }

  /** Restart from the uniform free stream (the body mask is kept). */
  reset(): void {
    const { size, solid, rho, ux, uy, f, g } = this;
    const u = this.u0;
    const usq = 1.5 * u * u;
    const e1 = W1 * (1 + 3 * u + 4.5 * u * u - usq);
    const e3 = W1 * (1 - 3 * u + 4.5 * u * u - usq);
    const e2 = W1 * (1 - usq);
    const e5 = W2 * (1 + 3 * u + 4.5 * u * u - usq);
    const e6 = W2 * (1 - 3 * u + 4.5 * u * u - usq);
    const e0 = W0 * (1 - usq);
    const fluid = [e0, e1, e2, e3, e2, e5, e6, e6, e5];
    for (let q = 0; q < 9; q++) {
      const fq = f[q];
      const gq = g[q];
      const vf = fluid[q];
      const vs = WQ[q];
      for (let x = 0; x < size; x++) {
        const v = solid[x] === 0 ? vf : vs;
        fq[x] = v;
        gq[x] = v;
      }
    }
    for (let x = 0; x < size; x++) {
      rho[x] = 1;
      ux[x] = solid[x] === 0 ? u : 0;
      uy[x] = 0;
    }
    this.stepCount = 0;
    this.rhoInlet = 1;
    this.dirtyTravel = 0;
    this.inletProfileClean = false;
    this.limiterHits = 0;
    this.accFx = 0;
    this.accFy = 0;
    this.accXFy = 0;
    this.accYFx = 0;
    this.accSteps = 0;
  }

  /** Advance `count` full steps (stream, collide, boundaries, loads). */
  step(count = 1): void {
    for (let n = 0; n < count; n++) this.stepOnce();
  }

  /** Mean aerodynamic load since the previous call; resets the accumulators. */
  takeForces(): ForceSample {
    const steps = this.accSteps;
    const inv = steps > 0 ? 1 / steps : 0;
    const sample: ForceSample = {
      fx: this.accFx * inv,
      fy: this.accFy * inv,
      xFy: this.accXFy * inv,
      yFx: this.accYFx * inv,
      steps,
    };
    this.accFx = 0;
    this.accFy = 0;
    this.accXFy = 0;
    this.accYFx = 0;
    this.accSteps = 0;
    return sample;
  }

  /** ∂uy/∂x − ∂ux/∂y (central differences); 0 in / next to solids and on the edges. */
  computeVorticity(out: Float32Array): void {
    const { nx, ny, ux, uy, flags } = this;
    if (out.length !== this.size) {
      throw new Error('LbmSolver.computeVorticity: tampon de taille incorrecte');
    }
    out.fill(0);
    for (let j = 1; j < ny - 1; j++) {
      const row = j * nx;
      for (let i = 1; i < nx - 1; i++) {
        const x = row + i;
        if (flags[x] !== FLAG_FAST) continue;
        out[x] = 0.5 * (uy[x + 1] - uy[x - 1] - ux[x + nx] + ux[x - nx]);
      }
    }
  }

  /** Density matching the upstream static pressure (mean over the inlet column). */
  referenceDensity(): number {
    const { nx, ny, rho } = this;
    let sum = 0;
    for (let j = 0; j < ny; j++) sum += rho[j * nx];
    const mean = sum / ny;
    return Number.isFinite(mean) && mean > 0 ? mean : 1;
  }

  /** Fast sampled sanity check: NaN / Inf, runaway density, saturated limiter. */
  isFinite(): boolean {
    const { size, rho, ux, uy } = this;
    if (this.limiterHits > 0.02 * size) return false;
    for (let x = 0; x < size; x += 3) {
      const r = rho[x];
      const s = r + ux[x] + uy[x];
      if (!(s === s) || !(r > 0.2 && r < 5) || !(Math.abs(s) < 10)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------

  private updateTau(): void {
    const { nx, tauCol } = this;
    const tau0 = 3 * this.nu + 0.5;
    const start = nx - 1 - SPONGE_COLUMNS;
    for (let i = 0; i < nx; i++) {
      let t = tau0;
      if (i > start) {
        const s = (i - start) / SPONGE_COLUMNS;
        t += SPONGE_TAU_BOOST * s * s;
      }
      tauCol[i] = t;
    }
  }

  private rebuildFlags(): void {
    const { nx, ny, solid, flags } = this;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      const edgeRow = j === 0 || j === ny - 1;
      for (let i = 0; i < nx; i++) {
        const x = row + i;
        flags[x] = solid[x] !== 0 ? FLAG_SOLID : edgeRow ? FLAG_SLOW : FLAG_FAST;
      }
    }
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        if (solid[row + i] === 0) continue;
        for (let q = 1; q < 9; q++) {
          const ni = i + EX[q];
          const nj = j + EY[q];
          if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) continue;
          const xn = ni + nj * nx;
          if (flags[xn] === FLAG_FAST) flags[xn] = FLAG_SLOW;
        }
      }
    }
  }

  /** Inlet velocity profile for the coming step (uniform, or synthetic wake). */
  private updateInletProfile(): void {
    const { ny, inU, inV } = this;
    const u0 = this.u0;
    const intensity = this.dirty;
    if (intensity <= 0) {
      if (!this.inletProfileClean) {
        inU.fill(u0);
        inV.fill(0);
        this.inletProfileClean = true;
      }
      return;
    }
    this.inletProfileClean = false;
    // Frozen-turbulence hypothesis: the eddy field is convected at u0.
    this.dirtyTravel += u0;
    const travel = this.dirtyTravel;
    const { modeKx, modePhase, modeU, modeV, modeCt, modeSt, modeSinY, modeCosY, wallDamp } = this;
    for (let m = 0; m < DIRTY_MODES; m++) {
      const ph = modePhase[m] - modeKx[m] * travel;
      modeCt[m] = Math.cos(ph) * modeU[m];
      modeSt[m] = Math.sin(ph) * modeV[m];
    }
    // The wake band meanders vertically.
    const yc =
      ny *
      (0.5 +
        0.1 * Math.sin((2 * Math.PI * travel) / (ny * 7.3)) +
        0.05 * Math.sin((2 * Math.PI * travel) / (ny * 2.9) + 1.3));
    const invSigma = 1 / (0.17 * ny);
    const deficit = DIRTY_DEFICIT * intensity;
    for (let j = 0; j < ny; j++) {
      const d = (j - yc) * invSigma;
      const env = Math.exp(-d * d);
      let du = 0;
      let dv = 0;
      for (let m = 0; m < DIRTY_MODES; m++) {
        du += modeCt[m] * modeSinY[m * ny + j];
        dv += modeSt[m] * modeCosY[m * ny + j];
      }
      const gain = intensity * (0.35 + 0.65 * env);
      let u = 1 - deficit * env + gain * du;
      let v = gain * dv * wallDamp[j];
      if (u < 0.2) u = 0.2;
      else if (u > 1.6) u = 1.6;
      if (v > 0.6) v = 0.6;
      else if (v < -0.6) v = -0.6;
      inU[j] = u0 * u;
      inV[j] = u0 * v;
    }
  }

  /**
   * Streaming for a fluid cell with a wall in its stencil (body, roof or
   * road). Fills `fin[1..8]` and accumulates the momentum exchanged with the
   * body. Kept out of the hot loop so the interior path stays tight.
   */
  private pullBoundary(src: Float32Array[], i: number, j: number, x: number): void {
    const nx = this.nx;
    const ny = this.ny;
    const solid = this.solid;
    const fin = this.fin;
    const movingWall = this.bottom === 'movingWall';
    const row = j * nx;
    let fxAcc = 0;
    let fyAcc = 0;
    let xFyAcc = 0;
    let yFxAcc = 0;
    for (let q = 1; q < 9; q++) {
      const ex = EX[q];
      const ey = EY[q];
      const si = i - ex;
      const sj = j - ey;
      let v: number;
      if (sj < 0 || sj >= ny) {
        if (sj >= ny && movingWall) {
          // Rolling road: half-way bounce-back + wall momentum.
          v = src[OPP[q]][x] + 6 * WQ[q] * this.rho[x] * ex * this.u0;
        } else {
          // Free-slip: specular reflection.
          const xs = row + si;
          v = solid[xs] !== 0 ? src[OPP[q]][x] : src[MIRROR_Y[q]][xs];
        }
      } else {
        const xs = si + sj * nx;
        if (solid[xs] !== 0) {
          // Half-way bounce-back on the body + momentum exchange.
          // The population left x along c = −e_q and came back reversed:
          // the wall received 2·c·f (rest-state part removed → gauge load).
          v = src[OPP[q]][x];
          const p = 2 * (v - WQ[q]);
          const lfx = -ex * p;
          const lfy = -ey * p;
          fxAcc += lfx;
          fyAcc += lfy;
          xFyAcc += (i - 0.5 * ex) * lfy;
          yFxAcc += (j - 0.5 * ey) * lfx;
        } else {
          v = src[q][xs];
        }
      }
      fin[q] = v;
    }
    this.accFx += fxAcc;
    this.accFy += fyAcc;
    this.accXFy += xFyAcc;
    this.accYFx += yFxAcc;
  }

  private stepOnce(): void {
    this.updateInletProfile();

    const nx = this.nx;
    const ny = this.ny;
    const src = this.f;
    const dst = this.g;
    const f0 = src[0];
    const f1 = src[1];
    const f2 = src[2];
    const f3 = src[3];
    const f4 = src[4];
    const f5 = src[5];
    const f6 = src[6];
    const f7 = src[7];
    const f8 = src[8];
    const g0 = dst[0];
    const g1 = dst[1];
    const g2 = dst[2];
    const g3 = dst[3];
    const g4 = dst[4];
    const g5 = dst[5];
    const g6 = dst[6];
    const g7 = dst[7];
    const g8 = dst[8];
    const rho = this.rho;
    const ux = this.ux;
    const uy = this.uy;
    const flags = this.flags;
    const tauCol = this.tauCol;
    const fin = this.fin;
    const iLast = nx - 1;

    let hits = 0;

    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 1; i < iLast; i++) {
        const x = row + i;
        const flag = flags[x];
        if (flag === FLAG_SOLID) continue;

        let a1: number;
        let a2: number;
        let a3: number;
        let a4: number;
        let a5: number;
        let a6: number;
        let a7: number;
        let a8: number;
        const a0 = f0[x];

        if (flag === FLAG_FAST) {
          // Pull streaming, no wall in the stencil.
          a1 = f1[x - 1];
          a3 = f3[x + 1];
          a2 = f2[x - nx];
          a4 = f4[x + nx];
          a5 = f5[x - nx - 1];
          a6 = f6[x - nx + 1];
          a7 = f7[x + nx + 1];
          a8 = f8[x + nx - 1];
        } else {
          // Generic path: body links, roof, road.
          this.pullBoundary(src, i, j, x);
          a1 = fin[1];
          a2 = fin[2];
          a3 = fin[3];
          a4 = fin[4];
          a5 = fin[5];
          a6 = fin[6];
          a7 = fin[7];
          a8 = fin[8];
        }

        // Moments.
        let r = a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8;
        const inv = 1 / r;
        let vx = (a1 + a5 + a8 - a3 - a6 - a7) * inv;
        let vy = (a2 + a5 + a6 - a4 - a7 - a8) * inv;

        // Safety limiters (NaN falls through every comparison untouched).
        if (r < RHO_MIN) {
          r = RHO_MIN;
          hits++;
        } else if (r > RHO_MAX) {
          r = RHO_MAX;
          hits++;
        }
        let usq = vx * vx + vy * vy;
        if (usq > U_LIMIT2) {
          const s = U_LIMIT / Math.sqrt(usq);
          vx *= s;
          vy *= s;
          usq = U_LIMIT2;
          hits++;
        }

        // Smagorinsky: local relaxation time from the non-equilibrium stress.
        const diag = a5 + a6 + a7 + a8;
        const pxx = a1 + a3 + diag - r * (1 / 3 + vx * vx);
        const pyy = a2 + a4 + diag - r * (1 / 3 + vy * vy);
        const pxy = a5 - a6 + a7 - a8 - r * vx * vy;
        const pnorm = Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy);
        const tau0 = tauCol[i];
        const omega = 2 / (tau0 + Math.sqrt(tau0 * tau0 + SMAG_K * pnorm * inv));
        const keep = 1 - omega;

        // BGK relaxation toward equilibrium.
        const c = 1 - 1.5 * usq;
        const r1 = W1 * r * omega;
        const r2 = W2 * r * omega;
        const vx3 = 3 * vx;
        const vy3 = 3 * vy;
        const vxx = 4.5 * vx * vx;
        const vyy = 4.5 * vy * vy;
        const dp = vx + vy;
        const dm = vx - vy;
        const dp3 = 3 * dp;
        const dm3 = 3 * dm;
        const dpp = 4.5 * dp * dp;
        const dmm = 4.5 * dm * dm;

        g0[x] = keep * a0 + W0 * r * omega * c;
        g1[x] = keep * a1 + r1 * (c + vx3 + vxx);
        g3[x] = keep * a3 + r1 * (c - vx3 + vxx);
        g2[x] = keep * a2 + r1 * (c + vy3 + vyy);
        g4[x] = keep * a4 + r1 * (c - vy3 + vyy);
        g5[x] = keep * a5 + r2 * (c + dp3 + dpp);
        g7[x] = keep * a7 + r2 * (c - dp3 + dpp);
        g8[x] = keep * a8 + r2 * (c + dm3 + dmm);
        g6[x] = keep * a6 + r2 * (c - dm3 + dmm);

        rho[x] = r;
        ux[x] = vx;
        uy[x] = vy;
      }
    }

    // Inlet — characteristic (non-reflecting) velocity inlet. The incoming
    // Riemann invariant u + cs·ρ'/ρ̄ is set from the target profile, the
    // outgoing one u − cs·ρ'/ρ̄ is extrapolated from the first fluid column,
    // so pressure waves running upstream leave instead of bouncing back. ρ̄
    // follows the mean inlet density slowly, which pins the time-averaged
    // inlet velocity to the target.
    // Outlet — convective extrapolation at the acoustic speed, softly relaxed
    // toward ρ = 1 to anchor the pressure level without reflecting.
    const inU = this.inU;
    const inV = this.inV;
    const rbar = this.rhoInlet;
    const invRbar = 1 / rbar;
    const lam = CS + this.u0;
    const cA = 1 / (1 + lam);
    const cB = lam * cA;
    let sumRin = 0;
    for (let j = 0; j < ny; j++) {
      const xi = j * nx;
      const target = inU[j];
      let vx = target;
      let r = rbar;
      if (flags[xi + 1] !== FLAG_SOLID) {
        const dr = (rho[xi + 1] - rbar) * invRbar;
        const u1 = ux[xi + 1];
        vx = 0.5 * (target + u1 - CS * dr);
        r = rbar * (1 + (target - u1 + CS * dr) * (0.5 / CS));
      }
      if (r < RHO_MIN) r = RHO_MIN;
      else if (r > RHO_MAX) r = RHO_MAX;
      if (vx < 0) vx = 0;
      else if (vx > U_LIMIT) vx = U_LIMIT;
      sumRin += r;
      const vy = inV[j];
      const c = 1 - 1.5 * (vx * vx + vy * vy);
      const r1 = W1 * r;
      const r2 = W2 * r;
      const dp = vx + vy;
      const dm = vx - vy;
      g0[xi] = W0 * r * c;
      g1[xi] = r1 * (c + 3 * vx + 4.5 * vx * vx);
      g3[xi] = r1 * (c - 3 * vx + 4.5 * vx * vx);
      g2[xi] = r1 * (c + 3 * vy + 4.5 * vy * vy);
      g4[xi] = r1 * (c - 3 * vy + 4.5 * vy * vy);
      g5[xi] = r2 * (c + 3 * dp + 4.5 * dp * dp);
      g7[xi] = r2 * (c - 3 * dp + 4.5 * dp * dp);
      g8[xi] = r2 * (c + 3 * dm + 4.5 * dm * dm);
      g6[xi] = r2 * (c - 3 * dm + 4.5 * dm * dm);
      rho[xi] = r;
      ux[xi] = vx;
      uy[xi] = vy;

      const xo = xi + iLast;
      const xs = xo - 1;
      const n0 = cA * f0[xo] + cB * g0[xs];
      const n1 = cA * f1[xo] + cB * g1[xs];
      const n2 = cA * f2[xo] + cB * g2[xs];
      const n3 = cA * f3[xo] + cB * g3[xs];
      const n4 = cA * f4[xo] + cB * g4[xs];
      const n5 = cA * f5[xo] + cB * g5[xs];
      const n6 = cA * f6[xo] + cB * g6[xs];
      const n7 = cA * f7[xo] + cB * g7[xs];
      const n8 = cA * f8[xo] + cB * g8[xs];
      const ro = n0 + n1 + n2 + n3 + n4 + n5 + n6 + n7 + n8;
      const d = OUTLET_RELAX * (1 - ro);
      g0[xo] = n0 + W0 * d;
      g1[xo] = n1 + W1 * d;
      g2[xo] = n2 + W1 * d;
      g3[xo] = n3 + W1 * d;
      g4[xo] = n4 + W1 * d;
      g5[xo] = n5 + W2 * d;
      g6[xo] = n6 + W2 * d;
      g7[xo] = n7 + W2 * d;
      g8[xo] = n8 + W2 * d;
      const io = 1 / ro;
      rho[xo] = ro + d;
      ux[xo] = (n1 + n5 + n8 - n3 - n6 - n7) * io;
      uy[xo] = (n2 + n5 + n6 - n4 - n7 - n8) * io;
    }
    const meanRin = sumRin / ny;
    if (meanRin === meanRin) this.rhoInlet = rbar + INLET_RELAX * (meanRin - rbar);

    this.f = dst;
    this.g = src;
    this.accSteps++;
    this.limiterHits = hits;
    this.stepCount++;
  }
}
