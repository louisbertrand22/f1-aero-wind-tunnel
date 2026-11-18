/**
 * Shared domain types — the contract between the physics core, the CFD
 * Web Worker, the canvas renderer and the telemetry UI.
 *
 * Grid conventions (used everywhere):
 *  - cell (i, j) with i ∈ [0, nx) growing downstream (flow goes +x) and
 *    j ∈ [0, ny) growing DOWNWARD (j = 0 runs along the roof, j = ny-1 along the road);
 *  - cell centres sit at integer coordinates; every row is fluid, the walls lie
 *    half a cell outside (roof at y = -0.5, road surface at y = ny - 0.5);
 *  - flat index `idx = i + j * nx`;
 *  - lattice units: dx = dt = 1, reference density 1, cs² = 1/3;
 *  - a force with positive `fy` points toward the road → it is DOWNFORCE.
 */

export type PresetId = 'rearWing' | 'frontWing' | 'floor' | 'freeform';

export type LayerId = 'pressure' | 'velocity' | 'vorticity' | 'smoke';

/** Everything the worker needs to run the tunnel. Sent whole on every change. */
export interface TunnelParams {
  preset: PresetId;
  /** Free-stream speed, km/h (100 – 360). */
  speedKmh: number;
  /** Global angle of attack / rake, degrees (meaning depends on the preset). */
  angleOfAttackDeg: number;
  /** Flap incidence / diffuser angle, degrees (meaning depends on the preset). */
  flapAngleDeg: number;
  /** Ground clearance in virtual millimetres (presets with ground effect). */
  rideHeightMm: number;
  /** Kinematic viscosity in units of 1e-5 m²/s (air at 15 °C ≈ 1.5). */
  viscosity: number;
  /** DRS command (the flap position itself is animated inside the worker). */
  drsOpen: boolean;
  /** Rolling road: bottom wall moves at free-stream speed. Otherwise free-slip. */
  movingGround: boolean;
  /** Inject the turbulent wake of a car running ahead. */
  dirtyAir: boolean;
  /** Gap to the car ahead in seconds (0.5 – 3.0). Smaller gap = stronger wake. */
  dirtyAirGapS: number;
  /** Smoke rake. */
  smokeEnabled: boolean;
  /** Number of nozzles on the rake (1 – 24). */
  smokeNozzles: number;
  /** Vertical centre of the rake, fraction of tunnel height (0 = roof, 1 = road). */
  smokeCenter: number;
  /** Rake span, fraction of tunnel height (0.05 – 1). */
  smokeSpread: number;
  /** Requested physical sub-steps per rendered frame (1 – 24). */
  substeps: number;
  paused: boolean;
}

export interface GridSize {
  nx: number;
  ny: number;
}

export const GRID_OPTIONS: readonly (GridSize & { label: string })[] = [
  { nx: 300, ny: 136, label: '300 × 136' },
  { nx: 400, ny: 180, label: '400 × 180' },
  { nx: 500, ny: 220, label: '500 × 220' },
];

export const DEFAULT_GRID: GridSize = { nx: 400, ny: 180 };

/** Axis-aligned bounds in grid coordinates (cells). */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Aerodynamic telemetry for the current frame (already time-smoothed). */
export interface Telemetry {
  /** Downforce, N (positive = pushes the car onto the road). */
  downforceN: number;
  /** Downforce, kgf. */
  downforceKgf: number;
  /** Drag, N (positive = opposes motion). */
  dragN: number;
  /** Aerodynamic efficiency = downforce / drag. */
  ld: number;
  /** Downforce coefficient (−C_L), referenced to the preset chord. */
  cl: number;
  /** Drag coefficient. */
  cd: number;
  /** Centre of pressure, grid x coordinate (cells). NaN when undefined. */
  copX: number;
  /** Centre of pressure, grid y coordinate used to draw the marker (cells). */
  copY: number;
  /** Centre of pressure as a fraction of body length from the leading edge (0 – 1). */
  copFrac: number;
  /** Bounds of the body the forces are integrated on (null when tunnel is empty). */
  bodyBounds: Bounds | null;
  /** Free-stream dynamic pressure, Pa. */
  qInf: number;
  /** Free-stream Mach number. */
  machInf: number;
  /** Reynolds number of the full-scale part (V·c/ν). */
  reynoldsPhys: number;
  /** Reynolds number actually resolved by the lattice. */
  reynoldsSim: number;
  /** Lattice free-stream velocity currently applied at the inlet. */
  uLattice: number;
  /** Lattice density that corresponds to free-stream static pressure. */
  rhoRef: number;
  /** Metres per lattice cell for the current preset / grid. */
  metersPerCell: number;
  /** Simulated tunnel time, seconds. */
  simTimeS: number;
  /** Total lattice steps since the last flow reset. */
  stepCount: number;
  /** False when the solver detected NaN / divergence and re-initialised. */
  stable: boolean;
}

/** Throughput figures measured inside the worker. */
export interface WorkerPerf {
  /** Lattice steps per wall-clock second. */
  stepsPerSecond: number;
  /** Mean cost of one lattice step, ms. */
  msPerStep: number;
  /** Sub-steps actually executed for this frame (may be throttled). */
  substeps: number;
  /** Million lattice-site updates per second. */
  mlups: number;
}

export interface PerfStats extends WorkerPerf {
  /** Frames received from the worker per second. */
  simFps: number;
  /** Canvas repaints per second. */
  renderFps: number;
}

export const EMPTY_PERF: PerfStats = {
  stepsPerSecond: 0,
  msPerStep: 0,
  substeps: 0,
  mlups: 0,
  simFps: 0,
  renderFps: 0,
};

export type TunnelStatus = 'booting' | 'running' | 'paused' | 'unstable';

/** A/B comparator reference run. */
export interface Baseline {
  label: string;
  /** `Date.now()` at capture. */
  capturedAt: number;
  params: TunnelParams;
  /** Telemetry averaged over the capture window. */
  telemetry: Telemetry;
}

export type BrushMode = 'paint' | 'erase';

/** Purely visual settings — never sent to the worker. */
export interface ViewSettings {
  layer: LayerId;
  /** Lagrangian tracer particles / streaklines overlay. */
  particles: boolean;
  /** Fluorescent flow-vis paint accumulated on the body surface. */
  flowVis: boolean;
  /** Pitot probe reticle on hover. */
  probe: boolean;
  /** Force vectors + centre-of-pressure marker on the body. */
  forces: boolean;
  brush: BrushMode;
  /** Brush radius in grid cells (1 – 12). */
  brushRadius: number;
}

export type TunnelCommand = 'resetFlow' | 'clearSculpt' | 'resetFlowVis' | 'clearSmoke';

export const DEFAULT_VIEW: ViewSettings = {
  layer: 'pressure',
  particles: true,
  flowVis: false,
  probe: true,
  forces: true,
  brush: 'paint',
  brushRadius: 4,
};

/** Physical constants used for the lattice ↔ SI conversion. */
export const AIR_DENSITY = 1.225; // kg/m³, ISA sea level
export const SPEED_OF_SOUND = 340.3; // m/s
export const G0 = 9.80665; // m/s²
