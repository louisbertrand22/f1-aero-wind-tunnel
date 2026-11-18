import type { PresetId, TunnelParams } from '../types';

/** A tunable setup parameter exposed by a preset. */
export interface RangeSpec {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

/**
 * Static description of a test article. Consumed by the geometry generator
 * (shape + scale), the worker (lattice → SI conversion) and the sidebar
 * (which sliders exist and how they are labelled).
 */
export interface PresetSpec {
  id: PresetId;
  label: string;
  shortLabel: string;
  description: string;
  /** Full-scale reference length (chord / floor length), metres. */
  refLengthM: number;
  /** Full-scale span the 2D section is extruded over, metres. */
  spanM: number;
  /** Finite-span / 3D relief factor applied to the 2D force coefficients. */
  k3d: number;
  /**
   * Virtual millimetres per lattice cell used for the ride-height slider on a
   * 400-cell-long grid (scales with 400 / nx). The vertical scale is
   * deliberately exaggerated on the floor so the Venturi throat is resolved.
   */
  rideMmPerCell400: number;
  aoa: RangeSpec | null;
  flap: RangeSpec | null;
  rideHeight: RangeSpec | null;
  /** Has a movable DRS flap. */
  drs: boolean;
  /** Rolling road enabled by default. */
  movingGroundDefault: boolean;
  /** The canvas brush edits the solid mask. */
  paintable: boolean;
}

export const PRESETS: Record<PresetId, PresetSpec> = {
  rearWing: {
    id: 'rearWing',
    label: 'Aileron arrière bi-plan',
    shortLabel: 'Aileron AR',
    description: 'Plan principal + volet DRS mobile, en air libre au-dessus de la carrosserie.',
    refLengthM: 0.48,
    spanM: 1.05,
    k3d: 0.72,
    rideMmPerCell400: 5,
    aoa: { label: 'Incidence plan principal', unit: '°', min: 0, max: 24, step: 0.5, default: 10 },
    flap: { label: 'Incidence volet', unit: '°', min: 10, max: 55, step: 0.5, default: 36 },
    rideHeight: null,
    drs: true,
    movingGroundDefault: false,
    paintable: false,
  },
  frontWing: {
    id: 'frontWing',
    label: 'Aileron avant multi-éléments',
    shortLabel: 'Aileron AV',
    description: 'Cascade à quatre éléments travaillant en effet de sol au-dessus du tapis roulant.',
    refLengthM: 0.52,
    spanM: 1.8,
    k3d: 0.6,
    rideMmPerCell400: 4.5,
    aoa: { label: 'Incidence plan principal', unit: '°', min: -2, max: 14, step: 0.5, default: 4 },
    flap: { label: 'Incidence volets', unit: '°', min: 6, max: 38, step: 0.5, default: 22 },
    rideHeight: { label: 'Garde au sol', unit: 'mm', min: 30, max: 220, step: 1, default: 85 },
    drs: false,
    movingGroundDefault: true,
    paintable: false,
  },
  floor: {
    id: 'floor',
    label: 'Fond plat & diffuseur Venturi',
    shortLabel: 'Fond plat',
    description: 'Tunnel Venturi complet : entrée, col et diffuseur, sol défilant à la vitesse de la voiture.',
    refLengthM: 3.4,
    spanM: 1.4,
    k3d: 0.45,
    rideMmPerCell400: 5,
    aoa: { label: 'Rake (assiette)', unit: '°', min: 0, max: 3, step: 0.1, default: 0.8 },
    flap: { label: 'Angle du diffuseur', unit: '°', min: 4, max: 24, step: 0.5, default: 13 },
    rideHeight: { label: 'Garde au sol', unit: 'mm', min: 25, max: 140, step: 1, default: 55 },
    drs: false,
    movingGroundDefault: true,
    paintable: false,
  },
  freeform: {
    id: 'freeform',
    label: 'Sculpture libre',
    shortLabel: 'Sculpture',
    description: 'Pinceau et gomme directement dans la veine : dessinez votre propre obstacle.',
    refLengthM: 0.4,
    spanM: 1,
    k3d: 1,
    rideMmPerCell400: 5,
    aoa: null,
    flap: null,
    rideHeight: null,
    drs: false,
    movingGroundDefault: false,
    paintable: true,
  },
};

export const PRESET_ORDER: readonly PresetId[] = ['rearWing', 'frontWing', 'floor', 'freeform'];

export const SPEED_RANGE: RangeSpec = { label: 'Vitesse du flux', unit: 'km/h', min: 100, max: 360, step: 1, default: 250 };
export const VISCOSITY_RANGE: RangeSpec = { label: 'Viscosité cinématique ν', unit: '×10⁻⁵ m²/s', min: 0.5, max: 6, step: 0.05, default: 1.5 };
export const SUBSTEP_RANGE: RangeSpec = { label: 'Sous-pas / image', unit: '', min: 1, max: 24, step: 1, default: 8 };
export const DIRTY_AIR_GAP_RANGE: RangeSpec = { label: 'Écart voiture de tête', unit: 's', min: 0.5, max: 3, step: 0.1, default: 1.5 };

/** Setup values a preset starts from (keeps tunnel-wide settings untouched). */
export function presetDefaults(id: PresetId): Pick<TunnelParams, 'preset' | 'angleOfAttackDeg' | 'flapAngleDeg' | 'rideHeightMm' | 'movingGround' | 'drsOpen'> {
  const spec = PRESETS[id];
  return {
    preset: id,
    angleOfAttackDeg: spec.aoa?.default ?? 0,
    flapAngleDeg: spec.flap?.default ?? 0,
    rideHeightMm: spec.rideHeight?.default ?? 0,
    movingGround: spec.movingGroundDefault,
    drsOpen: false,
  };
}

export const DEFAULT_PARAMS: TunnelParams = {
  ...presetDefaults('rearWing'),
  speedKmh: SPEED_RANGE.default,
  viscosity: VISCOSITY_RANGE.default,
  dirtyAir: false,
  dirtyAirGapS: DIRTY_AIR_GAP_RANGE.default,
  smokeEnabled: true,
  smokeNozzles: 12,
  smokeCenter: 0.5,
  smokeSpread: 0.7,
  substeps: SUBSTEP_RANGE.default,
  paused: false,
};

/** Virtual millimetres per lattice cell for the ride-height axis on a given grid. */
export function rideMmPerCell(id: PresetId, nx: number): number {
  return (PRESETS[id].rideMmPerCell400 * 400) / nx;
}
