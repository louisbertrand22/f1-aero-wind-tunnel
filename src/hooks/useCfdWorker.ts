import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { HistoryBuffer } from '../lib/history';
import { EMPTY_PERF } from '../types';
import type { GridSize, PerfStats, Telemetry, TunnelCommand, TunnelParams, TunnelStatus, WorkerPerf } from '../types';
import type { FrameBuffers, GeometryOutline, MainToWorker, WorkerToMain } from '../workers/protocol';
import { frameTransferList } from '../workers/protocol';

/** Latest field snapshot received from the worker (owned by the UI thread until recycled). */
export interface CfdFrame {
  frameId: number;
  nx: number;
  ny: number;
  buffers: FrameBuffers;
  telemetry: Telemetry;
  perf: WorkerPerf;
  outlines: GeometryOutline[];
  drs: number;
}

export interface CfdWorkerHandle {
  /** Mutable latest frame — read from requestAnimationFrame, never from render. */
  frameRef: RefObject<CfdFrame | null>;
  /** Rolling telemetry history sampled at ~30 Hz. */
  history: HistoryBuffer;
  /** Telemetry throttled to ~12 Hz for React consumers. */
  telemetry: Telemetry | null;
  perf: PerfStats;
  drsPosition: number;
  status: TunnelStatus;
  error: string | null;
  sendCommand: (command: TunnelCommand) => void;
  paint: (x0: number, y0: number, x1: number, y1: number, radius: number, erase: boolean) => void;
  reportRenderFps: (fps: number) => void;
}

const UI_PERIOD_MS = 80;
const HISTORY_PERIOD_MS = 33;
/** Lattice steps ignored after a flow reset (impulsive-start force spike). */
const HISTORY_SETTLE_STEPS = 500;

/**
 * Owns the CFD worker lifecycle and the buffer ping-pong. Field data stays in
 * a ref (the canvas pulls it at display rate); only low-rate telemetry goes
 * through React state.
 */
export function useCfdWorker(grid: GridSize, params: TunnelParams): CfdWorkerHandle {
  const workerRef = useRef<Worker | null>(null);
  const frameRef = useRef<CfdFrame | null>(null);
  const paramsRef = useRef(params);
  const renderFpsRef = useRef(0);
  /** True between a flow restart request and the first frame of the new flow. */
  const historyHoldRef = useRef(false);
  const [history] = useState(() => new HistoryBuffer(1200));
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [perf, setPerf] = useState<PerfStats>(EMPTY_PERF);
  const [drsPosition, setDrsPosition] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  paramsRef.current = params;

  const post = useCallback((message: MainToWorker, transfer?: Transferable[]) => {
    const worker = workerRef.current;
    if (!worker) return;
    if (transfer) worker.postMessage(message, transfer);
    else worker.postMessage(message);
  }, []);

  // Worker lifecycle — recreated only when the grid resolution changes.
  useEffect(() => {
    const worker = new Worker(new URL('../workers/cfd.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    setReady(false);
    setError(null);
    history.clear();

    const sessionStart = performance.now();
    let lastUi = 0;
    let lastHistory = 0;
    let fpsWindowStart = sessionStart;
    let fpsFrames = 0;
    let simFps = 0;

    worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const msg = event.data;
      if (msg.type === 'ready') {
        setReady(true);
        return;
      }
      if (msg.type === 'error') {
        setError(msg.message);
        return;
      }
      // Swap in the new frame and give the previous buffers back to the pool.
      const previous = frameRef.current;
      frameRef.current = {
        frameId: msg.frameId,
        nx: msg.nx,
        ny: msg.ny,
        buffers: msg.buffers,
        telemetry: msg.telemetry,
        perf: msg.perf,
        outlines: msg.outlines,
        drs: msg.drs,
      };
      if (previous) {
        worker.postMessage({ type: 'recycle', buffers: previous.buffers } satisfies MainToWorker, frameTransferList(previous.buffers));
      }

      const now = performance.now();
      fpsFrames++;
      if (now - fpsWindowStart >= 500) {
        simFps = (fpsFrames * 1000) / (now - fpsWindowStart);
        fpsWindowStart = now;
        fpsFrames = 0;
      }
      const running = !paramsRef.current.paused;
      // Frames still in flight from the previous flow must not leak into the new history.
      if (historyHoldRef.current && msg.telemetry.stepCount <= HISTORY_SETTLE_STEPS) historyHoldRef.current = false;
      if (running && !historyHoldRef.current && msg.telemetry.stable && now - lastHistory >= HISTORY_PERIOD_MS && msg.telemetry.stepCount > HISTORY_SETTLE_STEPS) {
        lastHistory = now;
        history.push({
          t: (now - sessionStart) / 1000,
          downforceN: msg.telemetry.downforceN,
          dragN: msg.telemetry.dragN,
          ld: msg.telemetry.ld,
        });
      }
      if (now - lastUi >= UI_PERIOD_MS) {
        lastUi = now;
        setTelemetry(msg.telemetry);
        setDrsPosition(msg.drs);
        setPerf({ ...msg.perf, simFps, renderFps: renderFpsRef.current });
      }
    };
    worker.onerror = (event) => {
      setError(event.message || 'Erreur inconnue dans le worker CFD');
    };

    worker.postMessage({ type: 'init', nx: grid.nx, ny: grid.ny, params: paramsRef.current } satisfies MainToWorker);

    return () => {
      worker.terminate();
      workerRef.current = null;
      frameRef.current = null;
    };
  }, [grid.nx, grid.ny, history]);

  // Push every setup change to the worker.
  const presetRef = useRef(params.preset);
  useEffect(() => {
    post({ type: 'setParams', params });
    if (presetRef.current !== params.preset) {
      // A new test article restarts the flow: its history starts from scratch.
      presetRef.current = params.preset;
      historyHoldRef.current = true;
      history.clear();
    }
  }, [params, post, history]);

  const sendCommand = useCallback(
    (command: TunnelCommand) => {
      post({ type: 'command', command });
      if (command === 'resetFlow') {
        historyHoldRef.current = true;
        history.clear();
      }
    },
    [post, history],
  );

  const paint = useCallback(
    (x0: number, y0: number, x1: number, y1: number, radius: number, erase: boolean) => {
      post({ type: 'paint', x0, y0, x1, y1, radius, erase });
    },
    [post],
  );

  const reportRenderFps = useCallback((fps: number) => {
    renderFpsRef.current = fps;
  }, []);

  let status: TunnelStatus = 'booting';
  if (ready && telemetry) {
    status = !telemetry.stable ? 'unstable' : params.paused ? 'paused' : 'running';
  }

  return { frameRef, history, telemetry, perf, drsPosition, status, error, sendCommand, paint, reportRenderFps };
}
