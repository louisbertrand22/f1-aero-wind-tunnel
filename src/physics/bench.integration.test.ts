import { describe, expect, it } from 'vitest';
import { buildGeometry, rasterizePolygons, seedFreeform } from '../geometry/airfoils';
import { PRESETS, PRESET_ORDER, presetDefaults } from '../geometry/presets';
import { FlowVisPaint } from './flowVis';
import { smoothFluidScalar } from './fieldFilters';
import { LbmSolver } from './lbmSolver';
import { SmokeField } from './smoke';
import { ForceFilter, dirtyAirIntensity, latticeVelocity, latticeViscosity } from './units';

const NX = 300;
const NY = 136;

/** Same wiring as the worker: preset geometry → mask → solver, at the top of the speed range. */
function runBench(preset: (typeof PRESET_ORDER)[number], steps: number) {
  const spec = PRESETS[preset];
  const setup = presetDefaults(preset);
  const solver = new LbmSolver(NX, NY);
  const mask = new Uint8Array(NX * NY);
  let refLengthCells = 1;
  if (spec.paintable) {
    mask.set(seedFreeform(NX, NY));
  } else {
    const geo = buildGeometry({ nx: NX, ny: NY, preset, angleOfAttackDeg: setup.angleOfAttackDeg, flapAngleDeg: setup.flapAngleDeg, rideHeightMm: setup.rideHeightMm, drs: 0 });
    rasterizePolygons(geo.polygons, NX, NY, mask);
    refLengthCells = geo.refLengthCells;
  }
  const u = latticeVelocity(360);
  solver.setViscosity(latticeViscosity(1));
  solver.setInletVelocity(u);
  solver.setBottomBoundary(setup.movingGround ? 'movingWall' : 'freeSlip');
  solver.setSolid(mask);
  solver.reset();
  const filter = new ForceFilter();
  for (let done = 0; done < steps; done += 20) {
    solver.step(20);
    filter.push(solver.takeForces());
  }
  return { solver, filter, u, refLengthCells, spec };
}

describe('wind tunnel bench (integration)', () => {
  for (const preset of PRESET_ORDER) {
    it(`${preset} stays numerically stable at 360 km/h and minimum viscosity`, () => {
      const { solver } = runBench(preset, 400);
      expect(solver.isFinite()).toBe(true);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < solver.size; i++) {
        const r = solver.rho[i];
        expect(Number.isFinite(r)).toBe(true);
        if (r < min) min = r;
        if (r > max) max = r;
      }
      expect(min).toBeGreaterThan(0.5);
      expect(max).toBeLessThan(1.6);
    });
  }

  it('converts lattice forces to finite, physically signed telemetry', () => {
    const { solver, filter, u, refLengthCells, spec } = runBench('rearWing', 1600);
    const telemetry = filter.toTelemetry({
      spec,
      speedKmh: 360,
      viscosity: 1,
      uLattice: u,
      nuLattice: latticeViscosity(1),
      rhoRef: solver.referenceDensity(),
      refLengthCells,
      refLengthM: spec.refLengthM,
      metersPerCell: spec.refLengthM / refLengthCells,
      bounds: { x0: 70, y0: 50, x1: 160, y1: 90 },
      simTimeS: 0,
      stepCount: solver.stepCount,
      stable: true,
    });
    for (const value of [telemetry.downforceN, telemetry.dragN, telemetry.ld, telemetry.cl, telemetry.cd, telemetry.qInf, telemetry.reynoldsSim]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    // An inverted, cambered wing pushes down and resists the flow.
    expect(telemetry.cl).toBeGreaterThan(0.2);
    expect(telemetry.cd).toBeGreaterThan(0);
    expect(telemetry.downforceKgf).toBeCloseTo(telemetry.downforceN / 9.80665, 6);
    expect(telemetry.machInf).toBeCloseTo(100 / 340.3, 6);
  });

  it('keeps post-processing fields bounded', () => {
    const { solver, u } = runBench('frontWing', 300);
    const smoke = new SmokeField(NX, NY);
    smoke.setNozzles(12, 0.5, 0.7);
    const paint = new FlowVisPaint(NX, NY);
    for (let k = 0; k < 20; k++) {
      solver.step(4);
      smoke.step(solver.ux, solver.uy, solver.solid, 4, true);
      paint.accumulate(solver.ux, solver.uy, solver.solid, u, 4);
    }
    const smoothed = new Float32Array(solver.size);
    smoothFluidScalar(solver.rho, solver.solid, NX, NY, smoothed);
    let painted = 0;
    for (let i = 0; i < solver.size; i++) {
      expect(paint.paint[i]).toBeGreaterThanOrEqual(0);
      expect(paint.paint[i]).toBeLessThanOrEqual(1);
      expect(Number.isFinite(smoothed[i])).toBe(true);
      if (solver.solid[i] === 0) expect(paint.paint[i]).toBe(0);
      else if (paint.paint[i] > 0) painted++;
    }
    expect(painted).toBeGreaterThan(0);
  });
});

describe('lattice ↔ SI mapping', () => {
  it('maps the speed range onto safe lattice velocities', () => {
    expect(latticeVelocity(100)).toBeCloseTo(0.035, 6);
    expect(latticeVelocity(360)).toBeCloseTo(0.085, 6);
    expect(latticeVelocity(50)).toBe(latticeVelocity(100));
    expect(latticeVelocity(500)).toBe(latticeVelocity(360));
  });

  it('keeps the lattice viscosity inside the stable band', () => {
    expect(latticeViscosity(0)).toBe(0.002);
    expect(latticeViscosity(1.5)).toBeCloseTo(0.0033, 6);
    expect(latticeViscosity(1000)).toBe(0.05);
  });

  it('weakens the wake as the gap to the car ahead grows', () => {
    expect(dirtyAirIntensity(false, 0.5)).toBe(0);
    expect(dirtyAirIntensity(true, 0.5)).toBe(1);
    expect(dirtyAirIntensity(true, 1.5)).toBeCloseTo(0.5, 6);
    expect(dirtyAirIntensity(true, 3)).toBeLessThan(dirtyAirIntensity(true, 1.5));
  });
});
