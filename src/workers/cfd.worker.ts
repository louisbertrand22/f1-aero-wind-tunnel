/**
 * CFD worker — owns the whole physical state of the tunnel.
 *
 * The UI thread never touches the solver: it posts setup changes and gets
 * back ~60 field snapshots per second as transferable typed arrays (see
 * `protocol.ts`). Each tick runs several lattice sub-steps inside a fixed
 * time budget, so a slow machine degrades simulation speed, never UI
 * responsiveness.
 */
import { LbmSolver } from '../physics/lbmSolver';
import { SmokeField } from '../physics/smoke';
import { FlowVisPaint } from '../physics/flowVis';
import { smoothFluidScalar } from '../physics/fieldFilters';
import { ForceFilter, dirtyAirIntensity, latticeVelocity, latticeViscosity } from '../physics/units';
import { buildGeometry, maskBounds, paintBrush, rasterizePolygons, seedFreeform } from '../geometry/airfoils';
import { PRESETS } from '../geometry/presets';
import type { Bounds, PresetId, TunnelCommand, TunnelParams } from '../types';
import { RUN_IN_STEPS, allocFrameBuffers, frameBuffersMatch, frameTransferList } from './protocol';
import type { FrameBuffers, GeometryOutline, MainToWorker, WorkerToMain } from './protocol';

/** Minimal typed view of the dedicated worker global (avoids the WebWorker lib clashing with DOM). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

const FRAME_MS = 1000 / 60;
/** Wall-clock budget for physics inside one tick. */
const STEP_BUDGET_MS = 11.5;
const POOL_SIZE = 3;
/** Seconds for a full DRS flap stroke. */
const DRS_STROKE_S = 0.32;
/** Lattice steps over which the inlet speed relaxes toward its target. */
const INLET_RAMP_STEPS = 260;
/**
 * During the run-in (see RUN_IN_STEPS) the worker trades frame rate for steps
 * — it never blocks the UI thread — so the bench settles about twice as fast.
 */
const RUN_IN_BUDGET_MS = 26;
const RUN_IN_SUBSTEPS = 16;
/**
 * A perfectly symmetric bluff body can take tens of thousands of steps to start
 * shedding. Sculpted bodies get a short burst of free-stream turbulence after
 * every flow reset to trip the Von Kármán street right away.
 */
const TRIP_STEPS = 700;
const TRIP_INTENSITY = 0.4;
/** Frames the "unstable" flag stays up after an automatic recovery. */
const UNSTABLE_HOLD_FRAMES = 90;

interface Tunnel {
  nx: number;
  ny: number;
  solver: LbmSolver;
  smoke: SmokeField;
  flowVis: FlowVisPaint;
  forces: ForceFilter;
  /** Solid mask currently applied to the solver. */
  mask: Uint8Array;
  /** User-sculpted mask (freeform preset), persistent across preset switches. */
  sculpt: Uint8Array;
  outlines: GeometryOutline[];
  bounds: Bounds | null;
  refLengthCells: number;
  refLengthM: number;
  metersPerCell: number;
  /** Actual DRS flap position (0 closed … 1 open). */
  drs: number;
  /** Inlet velocity currently applied (ramped toward the target). */
  uInlet: number;
  simTimeS: number;
  geometryKey: string;
  unstableFrames: number;
  pool: FrameBuffers[];
}

let tunnel: Tunnel | null = null;
let params: TunnelParams | null = null;
let frameId = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastTick = 0;
let nextTickAt = 0;
/** Smoothed cost of one lattice step, ms. */
let msPerStep = 1.2;
let stepsPerSecond = 0;
let rateWindowStart = 0;
let rateWindowSteps = 0;

function createTunnel(nx: number, ny: number, p: TunnelParams): Tunnel {
  const solver = new LbmSolver(nx, ny);
  const uInlet = latticeVelocity(p.speedKmh);
  solver.setViscosity(latticeViscosity(p.viscosity));
  solver.setInletVelocity(uInlet);
  solver.setBottomBoundary(p.movingGround ? 'movingWall' : 'freeSlip');
  solver.setDirtyAir(dirtyAirIntensity(p.dirtyAir, p.dirtyAirGapS));
  const smoke = new SmokeField(nx, ny);
  smoke.setNozzles(p.smokeNozzles, p.smokeCenter, p.smokeSpread);
  const pool: FrameBuffers[] = [];
  for (let k = 0; k < POOL_SIZE; k++) pool.push(allocFrameBuffers(nx, ny));
  const t: Tunnel = {
    nx,
    ny,
    solver,
    smoke,
    flowVis: new FlowVisPaint(nx, ny),
    forces: new ForceFilter(),
    mask: new Uint8Array(nx * ny),
    sculpt: seedFreeform(nx, ny),
    outlines: [],
    bounds: null,
    refLengthCells: 1,
    refLengthM: 1,
    metersPerCell: 1 / ny,
    drs: p.drsOpen && PRESETS[p.preset].drs ? 1 : 0,
    uInlet,
    simTimeS: 0,
    geometryKey: '',
    unstableFrames: 0,
    pool,
  };
  applyGeometry(t, p, true);
  solver.reset();
  return t;
}

function geometryKeyOf(p: TunnelParams, drs: number): string {
  return `${p.preset}|${p.angleOfAttackDeg}|${p.flapAngleDeg}|${p.rideHeightMm}|${drs.toFixed(4)}`;
}

/** Rebuild + rasterise the test article and hand the mask to the solver. */
function applyGeometry(t: Tunnel, p: TunnelParams, force = false): void {
  const key = geometryKeyOf(p, t.drs);
  if (!force && key === t.geometryKey) return;
  t.geometryKey = key;
  const spec = PRESETS[p.preset];

  if (spec.paintable) {
    t.mask.set(t.sculpt);
    t.outlines = [];
    t.bounds = maskBounds(t.mask, t.nx, t.ny);
    // Bluff bodies are referenced to their frontal height; the veine is 1 m tall.
    t.metersPerCell = 1 / t.ny;
    t.refLengthCells = t.bounds ? Math.max(1, t.bounds.y1 - t.bounds.y0) : 1;
    t.refLengthM = t.refLengthCells * t.metersPerCell;
  } else {
    const geo = buildGeometry({
      nx: t.nx,
      ny: t.ny,
      preset: p.preset,
      angleOfAttackDeg: p.angleOfAttackDeg,
      flapAngleDeg: p.flapAngleDeg,
      rideHeightMm: p.rideHeightMm,
      // Smoothstep easing: the actuator accelerates off its stop and lands softly.
      drs: t.drs * t.drs * (3 - 2 * t.drs),
    });
    rasterizePolygons(geo.polygons, t.nx, t.ny, t.mask);
    t.outlines = geo.polygons.map((poly) => ({ points: poly.points, movable: poly.movable }));
    t.bounds = geo.bounds;
    t.refLengthCells = Math.max(1, geo.refLengthCells);
    t.refLengthM = spec.refLengthM;
    t.metersPerCell = spec.refLengthM / t.refLengthCells;
  }
  t.solver.setSolid(t.mask);
}

function applyParams(next: TunnelParams): void {
  const prev = params;
  params = next;
  const t = tunnel;
  if (!t) return;
  const presetChanged = !prev || prev.preset !== next.preset;
  t.solver.setViscosity(latticeViscosity(next.viscosity));
  t.solver.setBottomBoundary(next.movingGround ? 'movingWall' : 'freeSlip');
  t.solver.setDirtyAir(dirtyAirIntensity(next.dirtyAir, next.dirtyAirGapS));
  t.smoke.setNozzles(next.smokeNozzles, next.smokeCenter, next.smokeSpread);
  if (presetChanged) {
    // A new test article invalidates the wake, the paint and the force history.
    t.drs = next.drsOpen && PRESETS[next.preset].drs ? 1 : 0;
    applyGeometry(t, next, true);
    t.uInlet = latticeVelocity(next.speedKmh);
    t.solver.setInletVelocity(t.uInlet);
    t.solver.reset();
    t.smoke.clear();
    t.flowVis.clear();
    t.forces.reset();
    t.simTimeS = 0;
  } else {
    applyGeometry(t, next);
  }
}

function runCommand(command: TunnelCommand): void {
  const t = tunnel;
  const p = params;
  if (!t || !p) return;
  switch (command) {
    case 'resetFlow':
      t.uInlet = latticeVelocity(p.speedKmh);
      t.solver.setInletVelocity(t.uInlet);
      t.solver.reset();
      t.smoke.clear();
      t.flowVis.clear();
      t.forces.reset();
      t.simTimeS = 0;
      break;
    case 'clearSculpt':
      t.sculpt.fill(0);
      if (PRESETS[p.preset].paintable) {
        applyGeometry(t, p, true);
        t.forces.reset();
      }
      break;
    case 'resetFlowVis':
      t.flowVis.clear();
      break;
    case 'clearSmoke':
      t.smoke.clear();
      break;
  }
}

function paint(x0: number, y0: number, x1: number, y1: number, radius: number, erase: boolean): void {
  const t = tunnel;
  const p = params;
  if (!t || !p || !PRESETS[p.preset].paintable) return;
  const r = Math.min(16, Math.max(0.5, radius));
  if (paintBrush(t.sculpt, t.nx, t.ny, x0, y0, x1, y1, r, erase)) applyGeometry(t, p, true);
}

/** Advance the physics by one display frame. Returns the lattice steps executed. */
function advance(t: Tunnel, p: TunnelParams, dtMs: number): number {
  const spec = PRESETS[p.preset];

  // DRS actuator: constant-rate stroke, eased in applyGeometry.
  const drsTarget = p.drsOpen && spec.drs ? 1 : 0;
  if (t.drs !== drsTarget) {
    const stroke = Math.min(0.05, dtMs / 1000) / DRS_STROKE_S;
    t.drs = drsTarget > t.drs ? Math.min(drsTarget, t.drs + stroke) : Math.max(drsTarget, t.drs - stroke);
    applyGeometry(t, p);
  }

  const runIn = t.solver.stepCount < RUN_IN_STEPS;
  const budgetMs = runIn ? RUN_IN_BUDGET_MS : STEP_BUDGET_MS;
  const wanted = runIn ? Math.max(RUN_IN_SUBSTEPS, Math.round(p.substeps)) : Math.round(p.substeps);
  const budgetSteps = Math.max(1, Math.floor(budgetMs / Math.max(0.05, msPerStep)));
  const target = Math.max(1, Math.min(wanted, budgetSteps));
  const uTarget = latticeVelocity(p.speedKmh);

  const tripping = spec.paintable && t.solver.stepCount < TRIP_STEPS;
  t.solver.setDirtyAir(Math.max(dirtyAirIntensity(p.dirtyAir, p.dirtyAirGapS), tripping ? TRIP_INTENSITY : 0));

  const t0 = performance.now();
  let done = 0;
  while (done < target) {
    const chunk = Math.min(2, target - done);
    if (t.uInlet !== uTarget) {
      const a = 1 - Math.exp(-chunk / INLET_RAMP_STEPS);
      t.uInlet += (uTarget - t.uInlet) * a;
      if (Math.abs(uTarget - t.uInlet) < 1e-5) t.uInlet = uTarget;
      t.solver.setInletVelocity(t.uInlet);
    }
    t.solver.step(chunk);
    done += chunk;
    if (performance.now() - t0 > budgetMs * 1.6) break;
  }
  const elapsed = performance.now() - t0;
  msPerStep += (elapsed / done - msPerStep) * 0.12;

  if (!t.solver.isFinite()) {
    // Divergence: restart from uniform flow rather than freezing the bench.
    t.solver.reset();
    t.smoke.clear();
    t.forces.reset();
    t.solver.takeForces();
    t.unstableFrames = UNSTABLE_HOLD_FRAMES;
    return done;
  }

  t.forces.push(t.solver.takeForces());
  t.smoke.step(t.solver.ux, t.solver.uy, t.solver.solid, done, p.smokeEnabled);
  t.flowVis.accumulate(t.solver.ux, t.solver.uy, t.solver.solid, t.uInlet, done);
  // One lattice step advances the fluid by u_lattice cells ⇒ dt = dx · u_lb / U∞.
  t.simTimeS += (done * t.metersPerCell * t.uInlet) / (p.speedKmh / 3.6);
  return done;
}

function publish(t: Tunnel, p: TunnelParams, substeps: number): void {
  const buffers = t.pool.pop();
  if (!buffers) return; // UI thread is behind — skip this snapshot.
  const s = t.solver;
  buffers.ux.set(s.ux);
  buffers.uy.set(s.uy);
  smoothFluidScalar(s.rho, s.solid, t.nx, t.ny, buffers.rho);
  s.computeVorticity(buffers.curl);
  buffers.smoke.set(t.smoke.rgb);
  buffers.flowVis.set(t.flowVis.paint);
  buffers.solid.set(s.solid);

  if (t.unstableFrames > 0) t.unstableFrames--;
  const telemetry = t.forces.toTelemetry({
    spec: PRESETS[p.preset],
    speedKmh: p.speedKmh,
    viscosity: p.viscosity,
    uLattice: t.uInlet,
    nuLattice: latticeViscosity(p.viscosity),
    rhoRef: s.referenceDensity(),
    refLengthCells: t.refLengthCells,
    refLengthM: t.refLengthM,
    metersPerCell: t.metersPerCell,
    bounds: t.bounds,
    simTimeS: t.simTimeS,
    stepCount: s.stepCount,
    stable: t.unstableFrames === 0,
  });

  const message: WorkerToMain = {
    type: 'frame',
    frameId: frameId++,
    nx: t.nx,
    ny: t.ny,
    buffers,
    telemetry,
    perf: {
      stepsPerSecond,
      msPerStep,
      substeps,
      mlups: (stepsPerSecond * t.nx * t.ny) / 1e6,
    },
    outlines: t.outlines,
    drs: t.drs,
  };
  scope.postMessage(message, frameTransferList(buffers));
}

function tick(): void {
  timer = null;
  const now = performance.now();
  const dtMs = lastTick > 0 ? now - lastTick : FRAME_MS;
  lastTick = now;

  const t = tunnel;
  const p = params;
  let period = FRAME_MS;
  if (t && p) {
    try {
      let steps = 0;
      if (p.paused) {
        period = 50; // idle refresh so paint strokes / setup edits still show up
        applyGeometry(t, p);
      } else {
        steps = advance(t, p, dtMs);
      }
      rateWindowSteps += steps;
      if (now - rateWindowStart >= 500) {
        stepsPerSecond = (rateWindowSteps * 1000) / (now - rateWindowStart);
        rateWindowStart = now;
        rateWindowSteps = 0;
      }
      publish(t, p, steps);
    } catch (error) {
      scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  // Fixed timeline → steady 60 Hz on average even with timer jitter.
  nextTickAt = Math.max(nextTickAt + period, performance.now());
  timer = setTimeout(tick, Math.max(0, nextTickAt - performance.now()));
}

function start(): void {
  if (timer !== null) return;
  lastTick = 0;
  nextTickAt = performance.now();
  rateWindowStart = nextTickAt;
  rateWindowSteps = 0;
  timer = setTimeout(tick, 0);
}

function isPresetId(value: string): value is PresetId {
  return value in PRESETS;
}

scope.onmessage = (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init': {
        if (!isPresetId(msg.params.preset)) throw new Error(`Preset inconnu : ${String(msg.params.preset)}`);
        params = msg.params;
        tunnel = createTunnel(msg.nx, msg.ny, msg.params);
        scope.postMessage({ type: 'ready', nx: msg.nx, ny: msg.ny });
        start();
        break;
      }
      case 'setParams':
        applyParams(msg.params);
        break;
      case 'paint':
        paint(msg.x0, msg.y0, msg.x1, msg.y1, msg.radius, msg.erase);
        break;
      case 'command':
        runCommand(msg.command);
        break;
      case 'recycle':
        if (tunnel && tunnel.pool.length < POOL_SIZE && frameBuffersMatch(msg.buffers, tunnel.nx, tunnel.ny)) {
          tunnel.pool.push(msg.buffers);
        }
        break;
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
