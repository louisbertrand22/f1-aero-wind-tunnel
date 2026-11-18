import { AIR_DENSITY, G0, SPEED_OF_SOUND } from '../types';
import type { Bounds, Telemetry } from '../types';
import type { PresetSpec } from '../geometry/presets';

/**
 * Lattice ↔ SI bridge.
 *
 * A 2D lattice cannot resolve the Reynolds number of a real F1 car (~10⁶–10⁷),
 * so the tunnel is run at a reduced Reynolds number and forces are scaled by
 * similarity: the solver yields dimensionless coefficients (C = F / ½ρu²L in
 * lattice units) which are re-dimensionalised with the full-scale dynamic
 * pressure and reference area. Free-stream speed maps to the lattice velocity
 * (so Mach / Reynolds trends follow the slider) and the kinematic viscosity
 * slider maps linearly to the lattice viscosity.
 */

/** Lattice free-stream velocity for a tunnel speed in km/h (100 → 0.035, 360 → 0.085). */
export function latticeVelocity(speedKmh: number): number {
  const t = (speedKmh - 100) / 260;
  return 0.035 + 0.05 * Math.min(1, Math.max(0, t));
}

/** Lattice kinematic viscosity for a physical ν given in 1e-5 m²/s (1.5 → 0.0033). */
export function latticeViscosity(viscosity: number): number {
  return Math.min(0.05, Math.max(0.002, 0.0022 * viscosity));
}

/** Wake intensity (0 – 1) felt at a given time gap behind another car. */
export function dirtyAirIntensity(enabled: boolean, gapS: number): number {
  if (!enabled) return 0;
  return Math.min(1, Math.max(0.15, 0.75 / Math.max(0.3, gapS)));
}

/** Raw per-step force average straight from the momentum-exchange integration. */
export interface LatticeForces {
  fx: number;
  fy: number;
  xFy: number;
  yFx: number;
  steps: number;
}

export interface TelemetryContext {
  spec: PresetSpec;
  speedKmh: number;
  /** Physical kinematic viscosity, 1e-5 m²/s. */
  viscosity: number;
  uLattice: number;
  nuLattice: number;
  rhoRef: number;
  /** Reference length of the body in cells. */
  refLengthCells: number;
  /** Full-scale reference length, metres. */
  refLengthM: number;
  metersPerCell: number;
  bounds: Bounds | null;
  simTimeS: number;
  stepCount: number;
  stable: boolean;
}

/**
 * Exponentially smoothed force integrator. LBM forces carry acoustic noise
 * (pressure waves bouncing in the tunnel); a time constant of ~150 lattice
 * steps removes it while keeping DRS transients readable.
 */
export class ForceFilter {
  private fx = 0;
  private fy = 0;
  private xFy = 0;
  private primed = false;
  /** Time constant in lattice steps. */
  readonly tau: number;

  constructor(tau = 150) {
    this.tau = tau;
  }

  reset(): void {
    this.fx = 0;
    this.fy = 0;
    this.xFy = 0;
    this.primed = false;
  }

  push(f: LatticeForces): void {
    if (f.steps <= 0) return;
    if (!Number.isFinite(f.fx) || !Number.isFinite(f.fy) || !Number.isFinite(f.xFy)) return;
    if (!this.primed) {
      this.fx = f.fx;
      this.fy = f.fy;
      this.xFy = f.xFy;
      this.primed = true;
      return;
    }
    const a = 1 - Math.exp(-f.steps / this.tau);
    this.fx += (f.fx - this.fx) * a;
    this.fy += (f.fy - this.fy) * a;
    this.xFy += (f.xFy - this.xFy) * a;
  }

  /** Convert the filtered lattice forces to full-scale telemetry. */
  toTelemetry(ctx: TelemetryContext): Telemetry {
    const { spec, bounds } = ctx;
    const v = ctx.speedKmh / 3.6;
    const qInf = 0.5 * AIR_DENSITY * v * v;
    const qLattice = 0.5 * ctx.rhoRef * ctx.uLattice * ctx.uLattice * Math.max(1, ctx.refLengthCells);
    const hasBody = bounds !== null && qLattice > 0;

    const cd = hasBody ? this.fx / qLattice : 0;
    const cl = hasBody ? this.fy / qLattice : 0;
    const area = ctx.refLengthM * spec.spanM * spec.k3d;
    const dragN = cd * qInf * area;
    const downforceN = cl * qInf * area;

    let copX = Number.NaN;
    let copY = Number.NaN;
    let copFrac = Number.NaN;
    if (bounds && Math.abs(cl) > 0.02) {
      const x = this.xFy / this.fy;
      const len = Math.max(1, bounds.x1 - bounds.x0);
      if (Number.isFinite(x)) {
        copFrac = Math.min(1, Math.max(0, (x - bounds.x0) / len));
        copX = bounds.x0 + copFrac * len;
        copY = 0.5 * (bounds.y0 + bounds.y1);
      }
    }

    const nuPhys = ctx.viscosity * 1e-5;
    return {
      downforceN,
      downforceKgf: downforceN / G0,
      dragN,
      // Efficiency is meaningless while drag crosses zero during transients.
      ld: cd > 0.02 ? Math.min(99, Math.max(-99, cl / cd)) : 0,
      cl,
      cd,
      copX,
      copY,
      copFrac,
      bodyBounds: bounds,
      qInf,
      machInf: v / SPEED_OF_SOUND,
      reynoldsPhys: (v * ctx.refLengthM) / nuPhys,
      reynoldsSim: (ctx.uLattice * ctx.refLengthCells) / ctx.nuLattice,
      uLattice: ctx.uLattice,
      rhoRef: ctx.rhoRef,
      metersPerCell: ctx.metersPerCell,
      simTimeS: ctx.simTimeS,
      stepCount: ctx.stepCount,
      stable: ctx.stable,
    };
  }
}
