import type { Telemetry, TunnelCommand, TunnelParams, WorkerPerf } from '../types';

/**
 * Wire protocol between the UI thread and `cfd.worker.ts`.
 *
 * Field data travels as Transferable typed-array buffers (zero-copy). The
 * worker owns a small pool of `FrameBuffers`; every `frame` message moves one
 * set to the UI thread, which MUST hand it back with a `recycle` message once
 * a newer frame has replaced it. If the pool is empty the worker keeps
 * stepping the physics and simply skips publishing.
 */
export interface FrameBuffers {
  /** x velocity, lattice units, length nx·ny. */
  ux: Float32Array;
  /** y velocity (positive = toward the road), lattice units. */
  uy: Float32Array;
  /** Density (pressure = rho / 3). */
  rho: Float32Array;
  /** Vorticity ∂uy/∂x − ∂ux/∂y. */
  curl: Float32Array;
  /** Smoke dye, interleaved RGB in [0, 1], length 3·nx·ny. */
  smoke: Float32Array;
  /** Flow-vis paint accumulated on surface cells, [0, 1]. */
  flowVis: Float32Array;
  /** 0 = fluid, 1 = solid body. */
  solid: Uint8Array;
}

/** Vector outlines of the test article, for crisp rendering over the raster. */
export interface GeometryOutline {
  /** Closed polygon, interleaved x,y in grid coordinates. */
  points: Float32Array;
  /** True for the DRS flap (highlighted while open). */
  movable: boolean;
}

export type MainToWorker =
  | { type: 'init'; nx: number; ny: number; params: TunnelParams }
  | { type: 'setParams'; params: TunnelParams }
  /** Brush segment in grid coordinates (freeform preset only). */
  | { type: 'paint'; x0: number; y0: number; x1: number; y1: number; radius: number; erase: boolean }
  | { type: 'command'; command: TunnelCommand }
  | { type: 'recycle'; buffers: FrameBuffers };

export type WorkerToMain =
  | { type: 'ready'; nx: number; ny: number }
  | {
      type: 'frame';
      frameId: number;
      nx: number;
      ny: number;
      buffers: FrameBuffers;
      telemetry: Telemetry;
      perf: WorkerPerf;
      outlines: GeometryOutline[];
      /** Actual DRS flap position, 0 = closed … 1 = fully open. */
      drs: number;
    }
  | { type: 'error'; message: string };

export function allocFrameBuffers(nx: number, ny: number): FrameBuffers {
  const n = nx * ny;
  return {
    ux: new Float32Array(n),
    uy: new Float32Array(n),
    rho: new Float32Array(n),
    curl: new Float32Array(n),
    smoke: new Float32Array(n * 3),
    flowVis: new Float32Array(n),
    solid: new Uint8Array(n),
  };
}

export function frameTransferList(b: FrameBuffers): Transferable[] {
  return [b.ux.buffer, b.uy.buffer, b.rho.buffer, b.curl.buffer, b.smoke.buffer, b.flowVis.buffer, b.solid.buffer];
}

/** True when a recycled buffer set still matches the current grid. */
export function frameBuffersMatch(b: FrameBuffers, nx: number, ny: number): boolean {
  const n = nx * ny;
  return b.ux.length === n && b.uy.length === n && b.rho.length === n && b.curl.length === n && b.smoke.length === n * 3 && b.flowVis.length === n && b.solid.length === n;
}
